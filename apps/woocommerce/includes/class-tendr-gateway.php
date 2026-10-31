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
 * - `_tendr_external_ref` `wc_<site hash>_<order id>`, kept for the order's life (every later session
 *   of the order reuses it): events are matched to the order by this stored value only.
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
	const META_CONNECTION   = '_tendr_connection_id';
	const META_MODE         = '_tendr_mode';
	const META_ATTEMPT      = '_tendr_attempt';
	const META_EXTERNAL_REF = '_tendr_external_ref';

	/** Session `expires_in` bounds (seconds), the API's own limits. */
	const MIN_EXPIRES_IN = 60;
	const MAX_EXPIRES_IN = 1800;

	/** Session statuses where money arrived or is arriving: never replace the session. */
	const IN_FLIGHT_SESSION_STATUSES = array( 'PROCESSING', 'SCREENING_PENDING', 'SETTLED', 'HELD', 'LATE_DEPOSIT' );

	/** Finished session statuses a new session may replace (when no payment is in flight). */
	const DEAD_SESSION_STATUSES = array( 'EXPIRED', 'REFUNDED' );

	/** Order meta: the last reason the auto-cancel kept the order (one note per reason). */
	const META_CANCEL_HOLD = '_tendr_cancel_hold';

	/** How long the thank-you page polls before it stops (ms). */
	const POLL_STOP_AFTER_MS = 3600000;

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
		$this->supports           = array( 'products', 'refunds' );

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
		add_action( 'woocommerce_order_status_changed', array( self::class, 'clear_session_url' ), 10, 4 );
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

	// ------------------------------------------------------------------ refunds.

	/**
	 * Refundable through tendr only when a tendr payment paid the order (its transaction id).
	 *
	 * @param WC_Order $order Order.
	 */
	public function can_refund_order( $order ) {
		return $order instanceof WC_Order && $this->supports( 'refunds' ) && '' !== Tendr_Refunds::payment_id( $order );
	}

	/**
	 * Never the way in: a refund "via tendr" is requested before WooCommerce saves it
	 * (Tendr_Refunds::before_save()), which stops WooCommerce before it calls this. Reaching it
	 * means some other path (a direct wc_refund_payment()); it must not create a second proposal.
	 *
	 * @param int        $order_id Order id.
	 * @param float|null $amount   Amount.
	 * @param string     $reason   Reason.
	 * @return WP_Error
	 */
	public function process_refund( $order_id, $amount = null, $reason = '' ) {
		return new WP_Error( 'tendr_refund_path', __( 'Refund tendr orders from the order screen: Refund, then "Refund via tendr".', 'tendr' ) );
	}

	// ------------------------------------------------------------------ sessions.

	/**
	 * A new order's ref: `wc_<first 12 hex of sha1(site id)>_<order id>`, unique per site and order.
	 * The site id is random and stored once (Tendr_Connect::site_id()), so the ref never depends on
	 * the site address: a domain move, http→https or a filtered home URL changes nothing.
	 *
	 * @param int $order_id Order id.
	 */
	public static function external_ref( int $order_id ): string {
		return 'wc_' . substr( sha1( Tendr_Connect::site_id() ), 0, 12 ) . '_' . $order_id;
	}

	/**
	 * The ref an order's sessions use: the one stored on the order when it has one (so every later
	 * session of the order, and events for its earlier ones, keep naming it), else a new one.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function order_ref( WC_Order $order ): string {
		$stored = (string) $order->get_meta( self::META_EXTERNAL_REF );
		if ( preg_match( '/^wc_[0-9a-f]{12}_([1-9][0-9]{0,19})$/', $stored, $m ) && (int) $m[1] === $order->get_id() ) {
			return $stored;
		}
		return self::external_ref( $order->get_id() );
	}

	/**
	 * The order an `external_ref` names: the order id it carries, when that order stores exactly
	 * this ref (compared in constant time); null otherwise. The ref is never recomputed, so orders
	 * made before a site address change still resolve. For the webhook receiver, which also checks
	 * the session's metadata `order_key` against the order.
	 *
	 * @param string $external_ref External ref from a session or event.
	 */
	public static function order_from_external_ref( string $external_ref ): ?WC_Order {
		if ( ! preg_match( '/^wc_[0-9a-f]{12}_([1-9][0-9]{0,19})$/', $external_ref, $m ) ) {
			return null;
		}
		$order = wc_get_order( (int) $m[1] );
		if ( ! $order instanceof WC_Order ) {
			return null;
		}
		$stored = (string) $order->get_meta( self::META_EXTERNAL_REF );
		return ( '' !== $stored && hash_equals( $stored, $external_ref ) ) ? $order : null;
	}

	/**
	 * The amount and currency a session was priced at, as the store gave them: the original total
	 * when tendr converted it, else the amount itself; null when the view carries neither.
	 *
	 * @param array $view Session view.
	 * @return array{0: string, 1: string}|null
	 */
	public static function session_total( array $view ): ?array {
		foreach ( array( array( 'original_amount', 'original_currency' ), array( 'amount', 'amount_currency' ) ) as $pair ) {
			$amount   = $view[ $pair[0] ] ?? null;
			$currency = $view[ $pair[1] ] ?? null;
			if ( is_string( $amount ) && '' !== $amount && is_string( $currency ) && '' !== $currency ) {
				return array( $amount, strtoupper( $currency ) );
			}
		}
		return null;
	}

	/**
	 * Whether a session was priced at the order's current total and currency (I1: the order may
	 * have been edited since the session was made). Decimals are compared as values ("49.00" = "49").
	 *
	 * @param array    $view  Session view.
	 * @param WC_Order $order Order.
	 */
	public static function same_total( array $view, WC_Order $order ): bool {
		$priced = self::session_total( $view );
		return null !== $priced
			&& strtoupper( (string) $order->get_currency() ) === $priced[1]
			&& self::decimal( $priced[0] ) === self::decimal( self::amount( $order ) );
	}

	/**
	 * A decimal string without leading or trailing zeros ("049.10" → "49.1"), for comparing values.
	 *
	 * @param string $value Decimal.
	 */
	private static function decimal( string $value ): string {
		$value = trim( $value );
		if ( str_contains( $value, '.' ) ) {
			$value = rtrim( rtrim( $value, '0' ), '.' );
		}
		$value = ltrim( $value, '0' );
		return ( '' === $value || str_starts_with( $value, '.' ) ) ? '0' . $value : $value;
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
			'external_ref'    => self::order_ref( $order ),
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

		$body += self::line_items_part( $order );
		return $body;
	}

	/** Most line items a session takes; the rest are left out (the order total still covers them). */
	const MAX_LINE_ITEMS = 50;

	/**
	 * `array( 'line_items' => … )`, or nothing for an order with no products.
	 *
	 * @param WC_Order $order Order.
	 */
	private static function line_items_part( WC_Order $order ): array {
		$items = self::line_items( $order );
		return array() === $items ? array() : array( 'line_items' => $items );
	}

	/**
	 * The order's products for the checkout page: name, quantity, unit price and (https) image.
	 * Display only: the session's amount is the order total.
	 *
	 * @param WC_Order $order Order.
	 * @return array<int, array<string, mixed>>
	 */
	public static function line_items( WC_Order $order ): array {
		$decimals = max( 0, wc_get_price_decimals() );
		$out      = array();
		foreach ( $order->get_items() as $item ) {
			if ( count( $out ) >= self::MAX_LINE_ITEMS ) {
				break;
			}
			if ( ! $item instanceof WC_Order_Item_Product ) {
				continue;
			}
			$name = trim( html_entity_decode( wp_strip_all_tags( (string) $item->get_name() ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
			if ( '' === $name ) {
				continue;
			}
			$line  = self::priced_line( $name, (float) $item->get_quantity(), (float) $item->get_total(), $decimals );
			$image = self::item_image( $item );
			if ( null !== $image ) {
				$line['image_url'] = $image;
			}
			$out[] = $line;
		}//end foreach
		return $out;
	}

	/**
	 * A line's name, quantity and unit price. The unit price is the line total divided by the
	 * quantity in whole minor units of the store's price decimals; when that does not divide
	 * exactly (or the quantity is fractional or out of range) the line is sent as one unit at the
	 * line total, with the quantity in the name ("Name × 3"), so the shown prices stay true.
	 *
	 * @param string $name     Product name.
	 * @param float  $quantity Quantity.
	 * @param float  $total    Line total.
	 * @param int    $decimals Store price decimals.
	 * @return array{name: string, quantity: int, unit_amount: string}
	 */
	public static function priced_line( string $name, float $quantity, float $total, int $decimals ): array {
		$minor = (int) round( max( 0.0, $total ) * ( 10 ** $decimals ) );
		if ( floor( $quantity ) === $quantity && $quantity >= 1 && $quantity <= 10000 && 0 === $minor % (int) $quantity ) {
			return array(
				'name'        => mb_substr( $name, 0, 200 ),
				'quantity'    => (int) $quantity,
				'unit_amount' => self::minor_to_decimal( intdiv( $minor, (int) $quantity ), $decimals ),
			);
		}
		$suffix = ' × ' . rtrim( rtrim( number_format( $quantity, 4, '.', '' ), '0' ), '.' );
		return array(
			'name'        => mb_substr( $name, 0, 200 - mb_strlen( $suffix ) ) . $suffix,
			'quantity'    => 1,
			'unit_amount' => self::minor_to_decimal( $minor, $decimals ),
		);
	}

	/**
	 * Minor units as a decimal string at `$decimals` places, without trailing fraction zeros (as
	 * amount(): the API checks against the currency's own decimals).
	 *
	 * @param int $minor    Amount in 10^-decimals units.
	 * @param int $decimals Decimals.
	 */
	private static function minor_to_decimal( int $minor, int $decimals ): string {
		$digits = str_pad( (string) $minor, $decimals + 1, '0', STR_PAD_LEFT );
		$value  = $decimals > 0 ? substr( $digits, 0, -$decimals ) . '.' . substr( $digits, -$decimals ) : $digits;
		if ( str_contains( $value, '.' ) ) {
			$value = rtrim( rtrim( $value, '0' ), '.' );
		}
		return $value;
	}

	/**
	 * The product's featured image URL, only when it is https.
	 *
	 * @param WC_Order_Item_Product $item Item.
	 */
	private static function item_image( WC_Order_Item_Product $item ): ?string {
		$product = $item->get_product();
		if ( ! $product instanceof WC_Product ) {
			return null;
		}
		$image_id = (int) $product->get_image_id();
		if ( $image_id <= 0 && $product->get_parent_id() > 0 ) {
			$parent   = wc_get_product( $product->get_parent_id() );
			$image_id = $parent instanceof WC_Product ? (int) $parent->get_image_id() : 0;
		}
		$url = $image_id > 0 ? wp_get_attachment_image_url( $image_id, 'full' ) : false;
		return Tendr_Brand::is_https_url( $url ) ? (string) $url : null;
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
			self::notice( self::error_notice( $session, $order ) );
			return array( 'result' => 'failure' );
		}

		return array(
			'result'   => 'success',
			'redirect' => $order->get_checkout_payment_url( true ),
		);
	}

	/**
	 * The checkout notice for a failed session. The API's own message is never shown.
	 *
	 * @param WP_Error $error Error.
	 * @param WC_Order $order Order.
	 */
	private static function error_notice( WP_Error $error, WC_Order $order ): string {
		if ( in_array( $error->get_error_code(), self::UNAVAILABLE_CODES, true ) ) {
			return __( 'Crypto payment is unavailable right now. Please choose another payment method or try again later.', 'tendr' );
		}
		if ( self::is_precision_error( $error ) ) {
			return sprintf(
				/* translators: %s: currency code, e.g. JPY. */
				__( 'Crypto payment is unavailable for this order: its total has more decimals than %s allows. The store\'s price decimals do not match its currency; please choose another payment method.', 'tendr' ),
				$order->get_currency()
			);
		}
		return __( 'Crypto payment could not be started. Please try again.', 'tendr' );
	}

	/**
	 * Whether the API refused the amount for having more decimals than the currency allows
	 * (`VALIDATION_ERROR`, `details.field = amount`, "… allows at most N decimal places").
	 *
	 * @param WP_Error $error Error.
	 */
	private static function is_precision_error( WP_Error $error ): bool {
		$data = $error->get_error_data();
		return 'VALIDATION_ERROR' === $error->get_error_code()
			&& is_array( $data ) && 'amount' === ( $data['field'] ?? null )
			&& str_contains( $error->get_error_message(), 'decimal places' );
	}

	/**
	 * Whether the API refused the session body (`VALIDATION_ERROR`, 400), for any field. The
	 * message is not relied on to name `line_items`: any refusal of a body that carried them is
	 * retried once without them.
	 *
	 * @param WP_Error $error Error.
	 */
	private static function is_validation_error( WP_Error $error ): bool {
		$data = $error->get_error_data();
		return 'VALIDATION_ERROR' === $error->get_error_code()
			&& 400 === (int) ( is_array( $data ) ? ( $data['status'] ?? 0 ) : 0 );
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
		$have_url   = self::is_session_url( (string) $order->get_meta( self::META_SESSION_URL ) );
		// The stored session, when shown again, needs its browser URL (cleared once the order
		// left pending; see clear_session_url()).
		$show_old = $have_url
			? $session_id
			: new WP_Error( 'tendr_session_unavailable', __( 'Crypto payment could not be started. Please try again.', 'tendr' ) );

		if ( '' !== $session_id ) {
			$stored_mode = 'live' === $order->get_meta( self::META_MODE ) ? 'live' : 'test';
			$view        = Tendr_Api_Client::request( 'GET', '/v1/checkout/sessions/' . rawurlencode( $session_id ), array(), $stored_mode );
			if ( is_wp_error( $view ) ) {
				if ( ! self::is_not_found( $view ) ) {
					return $view;
				}
			} else {
				$disposition = self::disposition( $view );
				if ( 'in_flight' === $disposition ) {
					return $show_old;
				}
				if ( 'open' === $disposition && $stored_mode === $mode ) {
					if ( self::same_total( $view, $order ) ) {
						return $show_old;
					}
					// I1: the order was edited since this session was made. Never let the shopper
					// pay the old amount: cancel it, then start one at the current total.
					$closed = self::close_for_new_total( $order, $session_id, $stored_mode );
					if ( true !== $closed ) {
						return is_wp_error( $closed ) ? $closed : $show_old;
					}
				}
			}//end if
		}//end if

		$created = $this->create_session( $order, $mode );
		if ( is_wp_error( $created ) && '' !== $session_id && 'CONFLICT' === $created->get_error_code() ) {
			// The API still holds the ref for the stored session (a deposit it can see is in flight).
			return $show_old;
		}
		return $created;
	}

	/**
	 * Cancel a still-open session priced at an older order total.
	 *
	 * @param WC_Order $order      Order.
	 * @param string   $session_id The stored session.
	 * @param string   $mode       Its mode.
	 * @return true|false|WP_Error true: closed (or gone), start a new one; false: a deposit is in
	 *                             flight or the session moved on, show it again; an error to retry.
	 */
	private static function close_for_new_total( WC_Order $order, string $session_id, string $mode ) {
		$result = Tendr_Api_Client::request( 'POST', '/v1/checkout/sessions/' . rawurlencode( $session_id ) . '/expire', array(), $mode );
		if ( is_wp_error( $result ) ) {
			if ( self::is_not_found( $result ) ) {
				return true;
			}
			if ( in_array( $result->get_error_code(), array( 'DEPOSIT_IN_PROGRESS', 'INVALID_STATE_TRANSITION' ), true ) ) {
				return false;
			}
			return $result;
		}
		$order->add_order_note( __( 'The order total changed after its crypto checkout started: that checkout was closed and a new one started at the current total.', 'tendr' ) );
		return true;
	}

	/**
	 * Whether an API error is the tendr API saying the session does not exist (HTTP 404 with
	 * code NOT_FOUND), not a 404 from something else (a proxy, a wrong API base).
	 *
	 * @param WP_Error $error Error.
	 */
	private static function is_not_found( WP_Error $error ): bool {
		return 404 === self::status_of( $error ) && 'NOT_FOUND' === $error->get_error_code();
	}

	/**
	 * What to do with a session, from its GET view:
	 * - 'dead' (replace) only for the known finished states: EXPIRED, REFUNDED, or PENDING_DEPOSIT
	 *   past its expiry, each with no payment in flight;
	 * - 'open' (reuse): PENDING_DEPOSIT before its expiry;
	 * - 'in_flight' (show it again, never replace): money in flight or arrived, and anything not
	 *   recognised (a future status, a missing expiry), the safe default.
	 *
	 * @param array $view `GET /v1/checkout/sessions/:id`.
	 */
	public static function disposition( array $view ): string {
		$status = isset( $view['status'] ) && is_string( $view['status'] ) ? $view['status'] : '';
		foreach ( ( isset( $view['payments'] ) && is_array( $view['payments'] ) ) ? $view['payments'] : array() as $payment ) {
			if ( is_array( $payment ) && isset( $payment['status'] ) && in_array( $payment['status'], self::IN_FLIGHT_PAYMENT_STATUSES, true ) ) {
				return 'in_flight';
			}
		}
		if ( in_array( $status, self::DEAD_SESSION_STATUSES, true ) ) {
			return 'dead';
		}
		if ( 'PENDING_DEPOSIT' === $status ) {
			$expires = isset( $view['expires_at'] ) && is_string( $view['expires_at'] ) ? strtotime( $view['expires_at'] ) : false;
			if ( false !== $expires ) {
				return $expires > time() ? 'open' : 'dead';
			}
		}
		return 'in_flight';
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
		// Line items are display only: if the API refuses a body that carried them (any 400
		// VALIDATION_ERROR), pay without them. The refused call used its key up (a 4xx), so the
		// retry takes the next key and a different body.
		if ( is_wp_error( $result ) && isset( $body['line_items'] ) && self::is_validation_error( $result ) ) {
			unset( $body['line_items'] );
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
		$connection = Tendr_Connect::connection();
		if ( null !== $connection ) {
			$order->update_meta_data( self::META_CONNECTION, (string) $connection['id'] );
		}
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
				'stopAfter' => self::POLL_STOP_AFTER_MS,
				'slowText'  => __( 'Confirmation is taking longer than usual. You will get an email when your payment is confirmed, and you can check your order later.', 'tendr' ),
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
	 * its session. The order is kept pending (return false) only when it must or might still be
	 * paid: tendr refuses because a deposit is in flight (or a payment exists), or tendr cannot be
	 * asked right now (transport failure, 5xx, 429, or a non-API response). The next run retries.
	 * Everything else lets WooCommerce cancel: the session is expired or unknown, or the failure
	 * is permanent (the site is disconnected, the key is revoked, any other 4xx), since no webhook
	 * could ever settle the order then. Each "not cancelled" note is written once per reason.
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
		$hold = self::cancel_hold_reason( $order, $session_id );
		if ( null === $hold ) {
			if ( '' !== (string) $order->get_meta( self::META_CANCEL_HOLD ) ) {
				$order->delete_meta_data( self::META_CANCEL_HOLD );
				$order->save();
			}
			return $cancel;
		}
		if ( (string) $order->get_meta( self::META_CANCEL_HOLD ) !== $hold ) {
			$order->update_meta_data( self::META_CANCEL_HOLD, $hold );
			$order->save();
			$order->add_order_note( self::cancel_hold_note( $hold ) );
		}
		return false;
	}

	/**
	 * Why the order must stay pending ('deposit' | 'payment' | 'earlier_connection' | 'unreachable'), or null to cancel.
	 *
	 * @param WC_Order $order      Order.
	 * @param string   $session_id Its session.
	 */
	private static function cancel_hold_reason( WC_Order $order, string $session_id ): ?string {
		$mode   = 'live' === $order->get_meta( self::META_MODE ) ? 'live' : 'test';
		$result = Tendr_Api_Client::request( 'POST', '/v1/checkout/sessions/' . rawurlencode( $session_id ) . '/expire', array(), $mode );
		if ( ! is_wp_error( $result ) ) {
			return null;
		}
		if ( 'DEPOSIT_IN_PROGRESS' === $result->get_error_code() ) {
			return 'deposit';
		}
		if ( 'INVALID_STATE_TRANSITION' === $result->get_error_code() ) {
			// The session is no longer open: cancel only if it simply finished unpaid.
			$view = Tendr_Api_Client::request( 'GET', '/v1/checkout/sessions/' . rawurlencode( $session_id ), array(), $mode );
			if ( ! is_wp_error( $view ) ) {
				return 'dead' === self::disposition( $view ) ? null : 'payment';
			}
			$result = $view;
		}
		if ( self::is_not_found( $result ) ) {
			// Sessions are scoped per connection: one made under an earlier connection answers
			// NOT_FOUND even though a deposit may be in flight, so never cancel on that answer.
			$stored  = (string) $order->get_meta( self::META_CONNECTION );
			$current = Tendr_Connect::connection();
			if ( '' !== $stored && null !== $current && $stored !== (string) $current['id'] ) {
				return 'earlier_connection';
			}
			return null;
		}
		return self::is_temporary( $result ) ? 'unreachable' : null;
	}

	/**
	 * Whether an API failure may go away on its own: a transport failure, an unreadable answer,
	 * 429, 5xx, or a response that did not come from the tendr API (no API error code: a proxy
	 * page, a wrong API base). Not connected, 401/403 and other API 4xx are permanent.
	 *
	 * @param WP_Error $error Error.
	 */
	private static function is_temporary( WP_Error $error ): bool {
		$code   = (string) $error->get_error_code();
		$status = self::status_of( $error );
		if ( 'tendr_unreachable' === $code || 'tendr_bad_response' === $code ) {
			return true;
		}
		if ( 429 === $status || $status >= 500 ) {
			return true;
		}
		return $status >= 400 && str_starts_with( $code, 'tendr_http_' );
	}

	/**
	 * The order note for a kept order.
	 *
	 * @param string $reason From cancel_hold_reason().
	 */
	private static function cancel_hold_note( string $reason ): string {
		switch ( $reason ) {
			case 'deposit':
				return __( 'Not cancelled: a crypto deposit is in progress for this order. The order stays pending and its stock stays held until tendr confirms the payment.', 'tendr' );
			case 'payment':
				return __( 'Not cancelled: tendr has a crypto payment for this order. The order stays pending until tendr confirms it.', 'tendr' );
			case 'earlier_connection':
				return __( 'This order\'s tendr payment belongs to an earlier connection — it can\'t be checked from here. Check the tendr dashboard before cancelling.', 'tendr' );
			default:
				return __( 'Not cancelled yet: tendr could not be reached to close the crypto checkout. WooCommerce will try again on its next run.', 'tendr' );
		}
	}

	// ------------------------------------------------------------------ retention.

	/**
	 * `woocommerce_order_status_changed`: once a tendr order leaves pending, forget the session's
	 * browser URL (it carries the session client secret). The session id stays for webhooks and
	 * refunds; paying a failed order again creates a new session.
	 *
	 * @param int           $order_id Order id.
	 * @param string        $from     Old status.
	 * @param string        $to       New status.
	 * @param WC_Order|null $order    Order.
	 */
	public static function clear_session_url( $order_id, $from, $to, $order = null ): void {
		if ( 'pending' === $to ) {
			return;
		}
		$order = $order instanceof WC_Order ? $order : wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || self::ID !== $order->get_payment_method() || '' === (string) $order->get_meta( self::META_SESSION_URL ) ) {
			return;
		}
		$order->delete_meta_data( self::META_SESSION_URL );
		$order->save_meta_data();
	}
}
