<?php
/**
 * The tendr payment gateway: the settings page (WooCommerce → Settings → Payments → tendr) and
 * checkout, classic and Blocks.
 *
 * Checkout: `process_payment()` creates (or reuses) a tendr checkout session for the order and
 * sends the shopper to the order-pay step, where `assets/js/checkout.js` opens the tendr modal
 * (falling back to the hosted page). The browser never marks an order paid: that is the signed
 * webhook's job (Task 10). The thank-you page only polls the order's status.
 *
 * Order meta (HPOS-safe, through the order object):
 * - `_tendr_session_id`   the current session (`ses_…`);
 * - `_tendr_session_url`  its hosted URL with the browser client secret (`…/pay/ses_…#cs=…`);
 * - `_tendr_mode`         'test' | 'live': the key the session was created with;
 * - `_tendr_attempt`      how many Idempotency-Keys this order has used up;
 * - `_tendr_external_ref` `wc_<site hash>_<order id>`.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Gateway `tendr`.
 */
class Tendr_Gateway extends WC_Payment_Gateway {

	const ID = 'tendr';

	const META_SESSION_ID   = '_tendr_session_id';
	const META_SESSION_URL  = '_tendr_session_url';
	const META_MODE         = '_tendr_mode';
	const META_ATTEMPT      = '_tendr_attempt';
	const META_EXTERNAL_REF = '_tendr_external_ref';

	/** Session `expires_in` bounds (seconds), the API's own limits. */
	const MIN_EXPIRES_IN = 60;
	const MAX_EXPIRES_IN = 1800;

	/** Session statuses where money arrived or is arriving: never replace the session. */
	const IN_FLIGHT_SESSION_STATUSES = array( 'PROCESSING', 'SCREENING_PENDING', 'SETTLED', 'HELD', 'LATE_DEPOSIT' );

	/** Payment statuses that mean the money is still on its way (the API's in-flight test). */
	const IN_FLIGHT_PAYMENT_STATUSES = array( 'DETECTED', 'PROCESSING', 'SCREENING_PENDING' );

	/** Error codes shown to the shopper as "unavailable right now". */
	const UNAVAILABLE_CODES = array( 'FX_RATE_UNAVAILABLE', 'ACCOUNT_NOT_READY' );

	/** How often the thank-you page asks for the order status (ms). */
	const POLL_INTERVAL_MS = 3000;

	/**
	 * Set up the gateway.
	 */
	public function __construct() {
		$this->id                 = self::ID;
		$this->method_title       = __( 'tendr', 'tendr' );
		$this->method_description = __( 'Take crypto payments that settle into your own tendr account.', 'tendr' );
		$this->title              = __( 'Pay with crypto', 'tendr' );
		$this->description        = __( 'Pay with crypto from any wallet or exchange.', 'tendr' );
		$this->order_button_text  = __( 'Pay with crypto', 'tendr' );
		$this->has_fields         = false;
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();
		$this->enabled = $this->get_option( 'enabled', 'no' );
	}

	/**
	 * Hooks that must exist whether or not WooCommerce has built its gateway list yet. Called once
	 * from Tendr_Plugin::boot().
	 */
	public static function register(): void {
		add_action( 'woocommerce_receipt_' . self::ID, array( self::class, 'receipt_page' ) );
		add_action( 'woocommerce_thankyou_' . self::ID, array( self::class, 'thankyou_page' ) );
		add_filter( 'woocommerce_cancel_unpaid_order', array( self::class, 'filter_cancel_unpaid_order' ), 10, 2 );
	}

	/**
	 * Settings fields. `enabled` is managed by Connect and Disconnect, and by the Payments list toggle.
	 */
	public function init_form_fields() {
		$this->form_fields = array(
			'enabled' => array(
				'title'   => __( 'Enable/Disable', 'tendr' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable tendr', 'tendr' ),
				'default' => 'no',
			),
		);
	}

	/**
	 * The settings page: Connect / connected state. WooCommerce's Save button is hidden because
	 * every action here is its own request.
	 */
	public function admin_options() {
		$GLOBALS['hide_save_button'] = true; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WooCommerce's documented switch.
		echo Tendr_Settings::render(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in Tendr_Settings::render().
	}

	/**
	 * Nothing to save from this page.
	 */
	public function process_admin_options() {
		return false;
	}

	/**
	 * Offered at checkout when enabled and connected. In test mode only store managers
	 * (`manage_woocommerce`) see it; guests and customers never do.
	 */
	public function is_available() {
		if ( ! parent::is_available() || ! Tendr_Connect::is_connected() ) {
			return false;
		}
		if ( 'test' === Tendr_Connect::mode() && ! current_user_can( 'manage_woocommerce' ) ) {
			return false;
		}
		return true;
	}

	// ------------------------------------------------------------------ sessions.

	/**
	 * `wc_<first 12 hex of sha1(home_url())>_<order id>`: unique per site and order.
	 *
	 * @param int $order_id Order id.
	 */
	public static function external_ref( int $order_id ): string {
		return 'wc_' . substr( sha1( home_url() ), 0, 12 ) . '_' . $order_id;
	}

	/**
	 * The order an `external_ref` names, when it was made by this site and the order has a tendr
	 * session under that ref; null otherwise. For the webhook receiver (Task 10), which must also
	 * check the event's metadata `order_key` against the order.
	 *
	 * @param string $external_ref External ref from a session or event.
	 */
	public static function order_from_external_ref( string $external_ref ): ?WC_Order {
		if ( ! preg_match( '/^wc_[0-9a-f]{12}_([1-9][0-9]{0,19})$/', $external_ref, $m ) ) {
			return null;
		}
		$order_id = (int) $m[1];
		if ( self::external_ref( $order_id ) !== $external_ref ) {
			return null;
		}
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || $order->get_meta( self::META_EXTERNAL_REF ) !== $external_ref ) {
			return null;
		}
		return $order;
	}

	/**
	 * Session lifetime in seconds from WooCommerce's hold-stock minutes, clamped to 60–1800 s. No
	 * hold-stock limit (empty or 0) means the API maximum.
	 *
	 * @param mixed $hold_minutes `woocommerce_hold_stock_minutes`.
	 */
	public static function expires_in( $hold_minutes ): int {
		$minutes = is_numeric( $hold_minutes ) ? (float) $hold_minutes : 0.0;
		if ( $minutes <= 0 ) {
			return self::MAX_EXPIRES_IN;
		}
		return (int) max( self::MIN_EXPIRES_IN, min( self::MAX_EXPIRES_IN, (int) round( $minutes * 60 ) ) );
	}

	/**
	 * The order total as a plain decimal string, without trailing fraction zeros ("78500.00" →
	 * "78500", "1.230" → "1.23"). WooCommerce stores totals with the store's price decimals, which
	 * need not match the currency (a JPY store at the default 2 decimals stores "1000.00"); the
	 * API checks the amount against the currency's minor units, and the value is unchanged.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function amount( WC_Order $order ): string {
		$total = $order->get_total();
		$total = is_float( $total ) ? number_format( $total, max( 0, wc_get_price_decimals() ), '.', '' ) : trim( (string) $total );
		if ( str_contains( $total, '.' ) ) {
			$total = rtrim( rtrim( $total, '0' ), '.' );
		}
		return '' === $total ? '0' : $total;
	}

	/**
	 * The `POST /v1/checkout/sessions` body for an order.
	 *
	 * @param WC_Order $order Order.
	 */
	public function session_body( WC_Order $order ): array {
		$body  = array(
			'amount'          => self::amount( $order ),
			'amount_currency' => $order->get_currency(),
			'external_ref'    => self::external_ref( $order->get_id() ),
			'success_url'     => $this->get_return_url( $order ),
			'cancel_url'      => $order->get_checkout_payment_url(),
			'expires_in'      => self::expires_in( get_option( 'woocommerce_hold_stock_minutes' ) ),
		);
		$email = $order->get_billing_email();
		if ( is_string( $email ) && '' !== $email && is_email( $email ) ) {
			$body['customer_email'] = $email;
		}
		$body['metadata'] = array(
			'order_number' => (string) $order->get_order_number(),
			'order_key'    => $order->get_order_key(),
			'site_url'     => home_url(),
		);
		return $body;
	}

	/**
	 * Create or reuse the order's session, then send the shopper to the order-pay step.
	 *
	 * @param int $order_id Order id.
	 * @return array{result: string, redirect?: string}
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			self::notice( __( 'Crypto payment could not be started. Please try again.', 'tendr' ) );
			return array( 'result' => 'failure' );
		}

		$session = $this->ensure_session( $order );
		if ( is_wp_error( $session ) ) {
			self::notice(
				in_array( $session->get_error_code(), self::UNAVAILABLE_CODES, true )
					? __( 'Crypto payment is unavailable right now. Please choose another payment method or try again later.', 'tendr' )
					: __( 'Crypto payment could not be started. Please try again.', 'tendr' )
			);
			return array( 'result' => 'failure' );
		}

		return array(
			'result'   => 'success',
			'redirect' => $order->get_checkout_payment_url( true ),
		);
	}

	/**
	 * The session the shopper should see for this order:
	 * - the stored session while it is open (`PENDING_DEPOSIT`, not expired);
	 * - the stored session again while a deposit is in flight or has arrived (never replaced);
	 * - otherwise a new one (the stored one expired, was refunded, or is unknown to the API).
	 *
	 * @param WC_Order $order Order.
	 * @return string|WP_Error The session id, or why there is none.
	 */
	public function ensure_session( WC_Order $order ) {
		$mode       = Tendr_Connect::mode();
		$session_id = (string) $order->get_meta( self::META_SESSION_ID );
		$stored_url = (string) $order->get_meta( self::META_SESSION_URL );
		$have_old   = '' !== $session_id && '' !== $stored_url;

		if ( $have_old ) {
			$stored_mode = 'live' === $order->get_meta( self::META_MODE ) ? 'live' : 'test';
			$view        = Tendr_Api_Client::request( 'GET', '/v1/checkout/sessions/' . rawurlencode( $session_id ), array(), $stored_mode );
			if ( is_wp_error( $view ) ) {
				if ( 404 !== self::status_of( $view ) ) {
					return $view;
				}
			} else {
				switch ( self::disposition( $view ) ) {
					case 'in_flight':
						return $session_id;
					case 'open':
						if ( $stored_mode === $mode ) {
							return $session_id;
						}
						break;
				}
			}
		}

		$created = $this->create_session( $order, $mode );
		if ( is_wp_error( $created ) && $have_old && 'CONFLICT' === $created->get_error_code() ) {
			// The API still holds the ref for the stored session (a deposit it can see is in flight).
			return $session_id;
		}
		return $created;
	}

	/**
	 * What to do with a session, from its GET view: 'in_flight' (show it again, never replace),
	 * 'open' (reuse), or 'dead' (replace).
	 *
	 * @param array $view `GET /v1/checkout/sessions/:id`.
	 */
	public static function disposition( array $view ): string {
		$status = isset( $view['status'] ) && is_string( $view['status'] ) ? $view['status'] : '';
		if ( in_array( $status, self::IN_FLIGHT_SESSION_STATUSES, true ) ) {
			return 'in_flight';
		}
		foreach ( ( isset( $view['payments'] ) && is_array( $view['payments'] ) ) ? $view['payments'] : array() as $payment ) {
			if ( is_array( $payment ) && isset( $payment['status'] ) && in_array( $payment['status'], self::IN_FLIGHT_PAYMENT_STATUSES, true ) ) {
				return 'in_flight';
			}
		}
		if ( 'PENDING_DEPOSIT' === $status ) {
			$expires = isset( $view['expires_at'] ) && is_string( $view['expires_at'] ) ? strtotime( $view['expires_at'] ) : false;
			if ( false !== $expires && $expires > time() ) {
				return 'open';
			}
		}
		return 'dead';
	}

	/**
	 * Create a session with the order's next Idempotency-Key (`<external_ref>-<n>`).
	 *
	 * A key is used up (`_tendr_attempt` = n) once the API answered for it with a session or a 4xx,
	 * because the API replays a stored answer for 24 h. A 5xx or a transport failure leaves the key
	 * unused, so a retry replays the first call if it did create a session. A key reused with a
	 * different body (the order total changed) is retried once with the next key.
	 *
	 * @param WC_Order $order Order.
	 * @param string   $mode  'test' | 'live'.
	 * @return string|WP_Error The new session id.
	 */
	private function create_session( WC_Order $order, string $mode ) {
		$body   = $this->session_body( $order );
		$result = self::create_once( $order, $body, $mode );
		if ( is_wp_error( $result ) && 'IDEMPOTENCY_CONFLICT' === $result->get_error_code() ) {
			$result = self::create_once( $order, $body, $mode );
		}
		return $result;
	}

	/**
	 * One `POST /v1/checkout/sessions` with the order's next Idempotency-Key.
	 *
	 * @param WC_Order $order Order.
	 * @param array    $body  Session body.
	 * @param string   $mode  'test' | 'live'.
	 * @return string|WP_Error The new session id.
	 */
	private static function create_once( WC_Order $order, array $body, string $mode ) {
		$attempt = absint( $order->get_meta( self::META_ATTEMPT ) ) + 1;
		$result  = Tendr_Api_Client::request(
			'POST',
			'/v1/checkout/sessions',
			$body,
			$mode,
			array( 'Idempotency-Key' => $body['external_ref'] . '-' . $attempt )
		);
		if ( ! is_wp_error( $result ) ) {
			return self::save_session( $order, $result, $attempt, $mode, $body['external_ref'] );
		}
		$status = self::status_of( $result );
		if ( $status >= 400 && $status < 500 && 'IDEMPOTENCY_IN_PROGRESS' !== $result->get_error_code() ) {
			$order->update_meta_data( self::META_ATTEMPT, (string) $attempt );
			$order->save();
		}
		return $result;
	}

	/**
	 * Record a created session on the order.
	 *
	 * @param WC_Order $order        Order.
	 * @param array    $created      `POST /v1/checkout/sessions` response.
	 * @param int      $attempt      The Idempotency-Key number used.
	 * @param string   $mode         'test' | 'live'.
	 * @param string   $external_ref External ref.
	 * @return string|WP_Error The session id.
	 */
	private static function save_session( WC_Order $order, array $created, int $attempt, string $mode, string $external_ref ) {
		$id  = isset( $created['id'] ) && is_string( $created['id'] ) ? $created['id'] : '';
		$url = isset( $created['url'] ) && is_string( $created['url'] ) ? $created['url'] : '';
		if ( ! preg_match( '/^ses_[0-9A-Za-z]{1,64}$/', $id ) || ! self::is_session_url( $url ) ) {
			return new WP_Error( 'tendr_bad_response', __( 'tendr sent a response this plugin could not read. Try again.', 'tendr' ) );
		}

		$order->update_meta_data( self::META_ATTEMPT, (string) $attempt );
		$order->update_meta_data( self::META_SESSION_ID, $id );
		$order->update_meta_data( self::META_SESSION_URL, $url );
		$order->update_meta_data( self::META_MODE, $mode );
		$order->update_meta_data( self::META_EXTERNAL_REF, $external_ref );
		$order->save();
		$order->add_order_note(
			'live' === $mode
				/* translators: %s: tendr checkout session id. */
				? sprintf( __( 'Crypto checkout started (tendr session %s).', 'tendr' ), $id )
				/* translators: %s: tendr checkout session id. */
				: sprintf( __( 'Crypto checkout started in test mode (tendr session %s).', 'tendr' ), $id )
		);
		return $id;
	}

	/**
	 * Whether a URL is a hosted checkout link on the tendr checkout origin.
	 *
	 * @param string $url URL.
	 */
	private static function is_session_url( string $url ): bool {
		$pattern = '#^' . preg_quote( Tendr_Plugin::checkout_base(), '#' ) . '/pay/ses_[0-9A-Za-z]{1,64}(?:\#cs=[0-9A-Za-z_]{1,200})?$#';
		return 1 === preg_match( $pattern, $url );
	}

	/**
	 * The HTTP status a Tendr_Api_Client error carries (0 when none).
	 *
	 * @param WP_Error $error Error.
	 */
	private static function status_of( WP_Error $error ): int {
		$data = $error->get_error_data();
		return ( is_array( $data ) && isset( $data['status'] ) ) ? (int) $data['status'] : 0;
	}

	/**
	 * A checkout error notice, when there is a WooCommerce session to carry it.
	 *
	 * @param string $message Plain text.
	 */
	private static function notice( string $message ): void {
		if ( function_exists( 'wc_add_notice' ) && WC()->session ) {
			wc_add_notice( esc_html( $message ), 'error' );
		}
	}

	// ------------------------------------------------------------------ pages.

	/**
	 * The order-pay step: open the tendr modal on the order's session. Without JavaScript (or if
	 * the modal cannot run), the link goes to the hosted checkout.
	 *
	 * @param int $order_id Order id.
	 */
	public static function receipt_page( $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || self::ID !== $order->get_payment_method() || ! $order->needs_payment() ) {
			return;
		}
		$session_url = (string) $order->get_meta( self::META_SESSION_URL );
		if ( ! self::is_session_url( $session_url ) ) {
			echo '<p class="tendr-pay">' . esc_html__( 'This crypto payment could not be started.', 'tendr' ) . ' <a href="' . esc_url( $order->get_checkout_payment_url() ) . '">' . esc_html__( 'Try again', 'tendr' ) . '</a></p>';
			return;
		}

		self::enqueue_checkout(
			array(
				'action'     => 'pay',
				'sessionUrl' => $session_url,
				'successUrl' => ( new self() )->get_return_url( $order ),
			)
		);

		echo '<div class="tendr-pay" data-tendr-pay>';
		echo '<p>' . esc_html__( 'Complete your payment in the tendr window.', 'tendr' ) . '</p>';
		echo '<p><button type="button" class="button alt" data-tendr-open>' . esc_html__( 'Pay with crypto', 'tendr' ) . '</button></p>';
		echo '<p><a href="' . esc_url( $session_url ) . '" rel="noopener" data-tendr-fallback>' . esc_html__( 'Having trouble? Open the payment page', 'tendr' ) . '</a></p>';
		echo '</div>';
	}

	/**
	 * The thank-you page: while the order is still pending, say so and poll the order status
	 * every 3 s; the page reloads once the webhook has moved the order.
	 *
	 * @param int $order_id Order id.
	 */
	public static function thankyou_page( $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || self::ID !== $order->get_payment_method() || ! $order->has_status( 'pending' ) ) {
			return;
		}

		self::enqueue_checkout(
			array(
				'action'    => 'wait',
				'statusUrl' => rest_url( Tendr_Order_Status::NAMESPACE . '/order-status/' . $order->get_order_key() ),
				'interval'  => self::POLL_INTERVAL_MS,
			)
		);

		echo '<p class="tendr-waiting" data-tendr-waiting role="status" aria-live="polite">' . esc_html__( 'Waiting for payment confirmation…', 'tendr' ) . '</p>';
	}

	/**
	 * Enqueue tendr.js (from the tendr checkout origin) and checkout.js with its data. The data
	 * carries only what the browser needs: the session's hosted URL, or the status URL.
	 *
	 * @param array $data `window.tendrCheckout`.
	 */
	private static function enqueue_checkout( array $data ): void {
		$deps = array();
		if ( 'pay' === $data['action'] ) {
			wp_enqueue_script( 'tendr-js', Tendr_Plugin::checkout_base() . '/v1/tendr.js', array(), null, true ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- served by tendr, always current.
			$deps[] = 'tendr-js';
		}
		wp_enqueue_script( 'tendr-checkout', plugins_url( 'assets/js/checkout.js', TENDR_PLUGIN_FILE ), $deps, TENDR_VERSION, true );
		wp_add_inline_script( 'tendr-checkout', 'window.tendrCheckout = ' . wp_json_encode( $data ) . ';', 'before' );
	}

	// ------------------------------------------------------------------ hold-stock auto-cancel.

	/**
	 * `woocommerce_cancel_unpaid_order`: before WooCommerce cancels an unpaid tendr order, cancel
	 * its session. If tendr refuses because a deposit is in flight, keep the order (and its stock)
	 * pending with a note; the payment webhook settles it. If tendr cannot be asked, keep the
	 * order too, and let the next run try again.
	 *
	 * @param bool     $cancel Whether WooCommerce will cancel the order.
	 * @param WC_Order $order  The unpaid order.
	 */
	public static function filter_cancel_unpaid_order( $cancel, $order ) {
		if ( ! $cancel || ! $order instanceof WC_Order || self::ID !== $order->get_payment_method() ) {
			return $cancel;
		}
		$session_id = (string) $order->get_meta( self::META_SESSION_ID );
		if ( '' === $session_id ) {
			return $cancel;
		}
		$mode   = 'live' === $order->get_meta( self::META_MODE ) ? 'live' : 'test';
		$result = Tendr_Api_Client::request( 'POST', '/v1/checkout/sessions/' . rawurlencode( $session_id ) . '/expire', array(), $mode );
		if ( ! is_wp_error( $result ) ) {
			return $cancel;
		}

		$code = $result->get_error_code();
		if ( 'DEPOSIT_IN_PROGRESS' === $code ) {
			$order->add_order_note( __( 'Not cancelled: a crypto deposit is in progress for this order. The order stays pending and its stock stays held until tendr confirms the payment.', 'tendr' ) );
			return false;
		}
		if ( 404 === self::status_of( $result ) ) {
			return $cancel;
		}
		if ( 'INVALID_STATE_TRANSITION' === $code ) {
			// The session is no longer open: cancel only if it simply expired.
			$view = Tendr_Api_Client::request( 'GET', '/v1/checkout/sessions/' . rawurlencode( $session_id ), array(), $mode );
			if ( ! is_wp_error( $view ) && 'dead' === self::disposition( $view ) ) {
				return $cancel;
			}
			if ( ! is_wp_error( $view ) ) {
				$order->add_order_note( __( 'Not cancelled: tendr has a crypto payment for this order. The order stays pending until tendr confirms it.', 'tendr' ) );
				return false;
			}
		}
		$order->add_order_note( __( 'Not cancelled yet: tendr could not be reached to close the crypto checkout. WooCommerce will try again on its next run.', 'tendr' ) );
		return false;
	}
}
