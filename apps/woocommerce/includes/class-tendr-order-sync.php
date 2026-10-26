<?php
/**
 * Moves WooCommerce orders from verified tendr events (spec §6).
 *
 * The event only says what to look at. Before any change the session is read again from the API
 * with the key of the event's mode, and that answer decides: a stale, replayed or out-of-order
 * event can never move an order backwards. Order changes only ever go forward:
 *
 * | Event (confirmed by the re-read)              | Order                                            |
 * |-----------------------------------------------|--------------------------------------------------|
 * | payment.succeeded, payment settled            | payment_complete( payment id ): Processing, or   |
 * |                                               | Completed for virtual/downloadable orders        |
 * | … overpaid                                    | + note: the extra is returned (or kept, < $1)    |
 * | payment.refunded underpaid/failed, can pay    | stays Pending, note                              |
 * | payment.refunded underpaid/failed, closed     | Pending → Failed, note                           |
 * | checkout.session.expired, no payment          | Pending → Cancelled (WooCommerce restocks)       |
 * | payment.late / payment.refunded late          | note only                                        |
 * | payment.held, order not paid                  | Pending/Failed → On hold, note with review link  |
 * | payment.held, order already paid or cancelled | note only                                        |
 * | payment.succeeded on a tendr-held order       | note only: it stays On hold                      |
 * | payment.refunded (merchant), refund.*         | Tendr_Refunds::apply_event()                     |
 *
 * An event for an older session of the order (a retry, a test/live switch) is still real money
 * for the order and is applied; only an expiry must be for the order's current session.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Order status sync.
 */
final class Tendr_Order_Sync {

	/** The payment a tendr hold put this order on hold for. */
	const META_HELD = '_tendr_held';

	/** Origin asset ids seen on events, by payment id (for notes on events that omit it). */
	const META_ASSETS = '_tendr_assets';

	const ORDER_EVENTS  = array(
		'payment.detected',
		'payment.processing',
		'payment.succeeded',
		'payment.late',
		'payment.held',
		'payment.refunded',
		'checkout.session.expired',
	);
	const REFUND_EVENTS = array(
		'refund.pending',
		'refund.sent',
		'refund.needs_address',
		'refund.cancelled',
		'refund.failed',
	);

	/** Payment statuses of a payment that settled (and maybe was refunded by the store since). */
	const SETTLED_PAYMENT_STATUSES = array( 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED' );

	/**
	 * Seconds to wait for another delivery working on the same order. With the re-read timeout it
	 * stays under the sender's 10 s timeout; on a timeout the receiver answers 503 at once.
	 */
	const LOCK_WAIT = 3;

	/** Seconds the session re-read may take inside a webhook request. */
	const REREAD_TIMEOUT = 5;

	/** 'yes' | 'no': whether the payment that marked the order paid was a live one. */
	const META_PAID_LIVEMODE = '_tendr_paid_livemode';

	/**
	 * Hooks: the test-payment warning on the order edit screen (classic and HPOS).
	 */
	public static function register(): void {
		add_action( 'woocommerce_admin_order_data_after_order_details', array( self::class, 'render_test_payment_notice' ) );
	}

	/**
	 * `woocommerce_admin_order_data_after_order_details`: a visible warning on orders a test-mode
	 * tendr payment marked paid.
	 *
	 * @param WC_Order|mixed $order Order being edited.
	 */
	public static function render_test_payment_notice( $order ): void {
		if ( ! $order instanceof WC_Order || 'no' !== $order->get_meta( self::META_PAID_LIVEMODE ) ) {
			return;
		}
		echo '<div class="notice notice-warning inline tendr-test-payment" style="clear:both;margin:12px 0 0;"><p><strong>'
			. esc_html__( 'Paid with a tendr TEST payment: no real money was received. Do not ship.', 'tendr' )
			. '</strong></p></div>';
	}

	/**
	 * Whether this plugin acts on an event type.
	 *
	 * @param string $type Event type.
	 */
	public static function handles( string $type ): bool {
		return in_array( $type, self::ORDER_EVENTS, true ) || in_array( $type, self::REFUND_EVENTS, true );
	}

	/**
	 * Find the event's order and apply the event to it.
	 *
	 * @param array $event Verified event.
	 * @return string|WP_Error What happened ('applied', 'noop', 'unknown_order', …), or an error
	 *                         when it could not be decided now (tendr should retry).
	 */
	public static function process( array $event ) {
		$data         = $event['data'];
		$external_ref = isset( $data['external_ref'] ) && is_string( $data['external_ref'] ) ? $data['external_ref'] : '';
		$order        = '' === $external_ref ? null : Tendr_Gateway::order_from_external_ref( $external_ref );
		if ( null === $order ) {
			self::log( $event, 'unknown_order' );
			return 'unknown_order';
		}

		global $wpdb;
		$lock = 'tendr_order_' . $wpdb->prefix . $order->get_id();
		if ( ! self::lock( $lock ) ) {
			return new WP_Error( 'tendr_order_locked', 'Another update for this order is running.' );
		}
		try {
			// Read the order again under the lock: another delivery may just have changed it.
			$order = wc_get_order( $order->get_id() );
			return $order instanceof WC_Order ? self::apply( $order, $event ) : 'unknown_order';
		} finally {
			self::unlock( $lock );
		}
	}

	/**
	 * Re-read the event's session from the API and apply what it confirms to the order.
	 *
	 * @param WC_Order $order Order the event's `external_ref` names.
	 * @param array    $event Verified event.
	 * @return string|WP_Error 'applied' | 'noop' | 'not_found' | 'mismatch', or an error to retry.
	 */
	public static function apply( WC_Order $order, array $event ) {
		$data       = $event['data'];
		$session_id = isset( $data['session_id'] ) && is_string( $data['session_id'] ) ? $data['session_id'] : '';
		if ( ! preg_match( '/^ses_[A-Za-z0-9]{1,64}$/', $session_id ) ) {
			self::log( $event, 'no_session' );
			return 'noop';
		}
		$mode = $event['livemode'] ? 'live' : 'test';
		$view = Tendr_Api_Client::request( 'GET', '/v1/checkout/sessions/' . rawurlencode( $session_id ), array(), $mode, array(), self::REREAD_TIMEOUT );
		if ( is_wp_error( $view ) ) {
			if ( 404 === self::status_of( $view ) && 'NOT_FOUND' === $view->get_error_code() ) {
				self::log( $event, 'session_not_found' );
				return 'not_found';
			}
			return $view;
		}

		// The session must be this order's: same ref, same mode, and its metadata order key.
		$meta = isset( $view['metadata'] ) && is_array( $view['metadata'] ) ? $view['metadata'] : array();
		$key  = isset( $meta['order_key'] ) && is_string( $meta['order_key'] ) ? $meta['order_key'] : '';
		if (
			( $view['external_ref'] ?? null ) !== $data['external_ref']
			|| ( $view['livemode'] ?? null ) !== $event['livemode']
			|| '' === $key
			|| ! hash_equals( (string) $order->get_order_key(), $key )
		) {
			self::log( $event, 'order_mismatch' );
			return 'mismatch';
		}

		self::remember_asset( $order, $data );

		if ( in_array( $event['type'], self::REFUND_EVENTS, true )
			|| ( 'payment.refunded' === $event['type'] && 'merchant' === ( $data['reason'] ?? null ) ) ) {
			return self::apply_refund_event( $order, $event, $view );
		}

		$payment = self::payment_of( $view, $data );
		switch ( $event['type'] ) {
			case 'payment.succeeded':
				return self::on_succeeded( $order, $event, $view, $payment );
			case 'payment.held':
				return self::on_held( $order, $event, $view, $payment );
			case 'payment.late':
				return self::on_late( $order, $event, $view, $payment );
			case 'payment.refunded':
				return self::on_refunded( $order, $event, $view, $payment );
			case 'checkout.session.expired':
				return self::on_expired( $order, $event, $view );
			default:
				// payment.detected / payment.processing: the order waits; nothing ever moves back.
				return 'noop';
		}
	}

	/**
	 * Store refunds and refund outcomes (`refund.*`, `payment.refunded` with reason `merchant`):
	 * see Tendr_Refunds::apply_event().
	 *
	 * @param WC_Order $order Order.
	 * @param array    $event Verified event.
	 * @param array    $view  The session as re-read from the API.
	 * @return string|WP_Error 'applied' | 'noop', or an error: the receiver answers 503 and does
	 *                         not record the event, so tendr retries.
	 */
	public static function apply_refund_event( WC_Order $order, array $event, array $view ) {
		/**
		 * A verified refund event for a tendr order, after the session re-read.
		 *
		 * @param WC_Order $order Order.
		 * @param array    $event Event.
		 * @param array    $view  Session view.
		 */
		do_action( 'tendr_refund_event', $order, $event, $view );
		$result = Tendr_Refunds::apply_event( $order, $event, $view );
		if ( 'noop' === $result ) {
			self::log( $event, 'refund_unchanged' );
		}
		return $result;
	}

	// ------------------------------------------------------------------ events.

	/**
	 * `payment.succeeded`: payment_complete() when the re-read shows the payment settled.
	 *
	 * @param WC_Order   $order   Order.
	 * @param array      $event   Event.
	 * @param array      $view    Session view.
	 * @param array|null $payment The event's payment in the view.
	 * @return string
	 */
	private static function on_succeeded( WC_Order $order, array $event, array $view, ?array $payment ): string {
		if ( null === $payment || ! self::is_settled( $payment ) ) {
			self::log( $event, 'not_settled' );
			return 'noop';
		}
		$payment_id = (string) $payment['id'];
		$details    = self::payment_details( $order, $event, $view, $payment );

		if ( '' !== (string) $order->get_meta( self::META_HELD ) && 'on-hold' === $order->get_status() ) {
			self::note(
				$order,
				$event,
				__( 'A crypto payment settled for this order, but the order stays on hold because an earlier payment for it is held for review. Check the tendr review queue before shipping.', 'tendr' )
				. ' ' . $details . ' ' . self::review_link()
			);
			return 'applied';
		}

		if ( ( self::is_paid( $order ) || $order->has_status( 'refunded' ) ) && $order->get_transaction_id() === $payment_id ) {
			// This payment already paid the order (a resend, or since refunded): nothing to say.
			return 'noop';
		}

		if ( self::is_paid( $order ) ) {
			self::note(
				$order,
				$event,
				__( 'Another crypto payment settled for this order, which is already paid. Refund it from the order if it was not expected.', 'tendr' ) . ' ' . $details
			);
			return 'applied';
		}

		$fx_line = self::fx_line( $view );
		$fx_text = null === $fx_line ? '' : ' ' . $fx_line;

		// A cancelled order never moves back on its own: the merchant cancelled it, or its stock
		// was released when the checkout expired.
		if ( $order->has_status( 'cancelled' ) ) {
			self::note(
				$order,
				$event,
				__( 'Payment received for a cancelled order: reopen the order or refund it from tendr.', 'tendr' ) . ' ' . $details . $fx_text . self::overpaid_line( $payment )
			);
			return 'applied';
		}

		// WooCommerce's own filter, read with the same default payment_complete() uses.
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- WooCommerce core hook.
		$valid = (array) apply_filters( 'woocommerce_valid_order_statuses_for_payment_complete', array( 'on-hold', 'pending', 'failed', 'cancelled' ), $order );
		if ( ! $order->has_status( array_diff( $valid, array( 'cancelled' ) ) ) ) {
			self::note( $order, $event, __( 'A crypto payment settled for this order, but its status does not allow marking it paid.', 'tendr' ) . ' ' . $details );
			return 'applied';
		}

		$order->update_meta_data( self::META_PAID_LIVEMODE, empty( $event['livemode'] ) ? 'no' : 'yes' );
		$order->payment_complete( $payment_id );
		$text = __( 'Crypto payment received.', 'tendr' ) . ' ' . $details . $fx_text . self::overpaid_line( $payment );
		self::note( $order, $event, $text );
		return 'applied';
	}

	/**
	 * `payment.held`: On hold (never Processing later) when the order is not yet paid; a note
	 * otherwise, e.g. a store refund of a settled payment blocked for review.
	 *
	 * @param WC_Order   $order   Order.
	 * @param array      $event   Event.
	 * @param array      $view    Session view.
	 * @param array|null $payment The event's payment.
	 * @return string
	 */
	private static function on_held( WC_Order $order, array $event, array $view, ?array $payment ): string {
		if ( null === $payment || ( 'HELD' !== ( $payment['status'] ?? null ) && 'sanctions' !== ( $payment['held_reason'] ?? null ) ) ) {
			self::log( $event, 'not_held' );
			return 'noop';
		}
		$details = self::payment_details( $order, $event, $view, $payment );

		if ( self::is_paid( $order ) || 'refunded' === $order->get_status() ) {
			self::note(
				$order,
				$event,
				__( 'tendr is holding a crypto return for this order for review: the wallet that paid failed sanctions screening. Nothing is sent until it is reviewed.', 'tendr' )
				. ' ' . $details . ' ' . self::review_link()
			);
			return 'applied';
		}

		$text = __( 'A crypto payment for this order is on hold for review: the paying wallet failed sanctions screening. tendr never releases held funds on its own, and this order will not move to Processing.', 'tendr' )
			. ' ' . $details . ' ' . self::review_link();

		if ( $order->has_status( array( 'pending', 'failed' ) ) ) {
			$order->update_meta_data( self::META_HELD, (string) $payment['id'] );
			$order->update_status( 'on-hold', self::prefix( $event ) . $text );
			return 'applied';
		}
		// Cancelled (a late payment) or already on hold: tell the merchant, keep the status.
		if ( 'on-hold' === $order->get_status() && '' === (string) $order->get_meta( self::META_HELD ) ) {
			$order->update_meta_data( self::META_HELD, (string) $payment['id'] );
			$order->save();
		}
		self::note( $order, $event, $text );
		return 'applied';
	}

	/**
	 * `payment.late`: a note only; tendr returns a late payment to the shopper.
	 *
	 * @param WC_Order   $order   Order.
	 * @param array      $event   Event.
	 * @param array      $view    Session view.
	 * @param array|null $payment The event's payment.
	 * @return string
	 */
	private static function on_late( WC_Order $order, array $event, array $view, ?array $payment ): string {
		if ( null === $payment || true !== ( $payment['is_late'] ?? null ) ) {
			self::log( $event, 'not_late' );
			return 'noop';
		}
		self::note(
			$order,
			$event,
			__( 'A crypto payment arrived after this checkout expired. tendr is returning it to the shopper; the order is unchanged.', 'tendr' )
			. ' ' . self::payment_details( $order, $event, $view, $payment )
		);
		return 'applied';
	}

	/**
	 * `payment.refunded` for a payment that never settled (underpaid, failed swap, late, held).
	 *
	 * @param WC_Order   $order   Order.
	 * @param array      $event   Event.
	 * @param array      $view    Session view.
	 * @param array|null $payment The event's payment.
	 * @return string
	 */
	private static function on_refunded( WC_Order $order, array $event, array $view, ?array $payment ): string {
		if ( null === $payment || self::is_settled( $payment ) || ! in_array( $payment['status'] ?? null, array( 'REFUNDING', 'REFUNDED' ), true ) ) {
			self::log( $event, 'not_refunded' );
			return 'noop';
		}
		$reason  = isset( $event['data']['reason'] ) && is_string( $event['data']['reason'] ) ? $event['data']['reason'] : '';
		$details = self::payment_details( $order, $event, $view, $payment );

		if ( 'underpaid' === $reason || 'failed' === $reason ) {
			$what = 'underpaid' === $reason
				? __( 'Underpaid: the shopper sent less than the order total, and tendr is returning the deposit to them.', 'tendr' )
				: __( 'The crypto payment could not be completed, and tendr is returning the deposit to the shopper.', 'tendr' );
			// Only the order's current session decides its status; an older session's return is
			// just news (the current session may still be payable).
			$current = (string) $order->get_meta( Tendr_Gateway::META_SESSION_ID ) === (string) ( $view['id'] ?? '' );
			if ( ! $order->has_status( 'pending' ) || ! $current ) {
				self::note( $order, $event, $what . ' ' . $details );
				return 'applied';
			}
			if ( self::can_still_pay( $order, $event, $view ) ) {
				self::note( $order, $event, $what . ' ' . __( 'The shopper can still pay the full amount; the order stays pending.', 'tendr' ) . ' ' . $details );
				return 'applied';
			}
			$order->update_status(
				'failed',
				self::prefix( $event ) . $what . ' ' . __( 'The deposit was returned and the checkout is closed; the shopper can try again from the order.', 'tendr' ) . ' ' . $details
			);
			return 'applied';
		}//end if

		if ( 'on-hold' === $order->get_status() && '' !== (string) $order->get_meta( self::META_HELD ) ) {
			self::note(
				$order,
				$event,
				__( 'The held payment was returned to the wallet that sent it. This order is still on hold: cancel this order if it will not be paid.', 'tendr' ) . ' ' . $details
			);
			return 'applied';
		}

		$text = 'late' === $reason
			? __( 'The late payment is being returned to the shopper; the order is unchanged.', 'tendr' )
			: __( 'tendr is returning a crypto payment for this order to the shopper; the order is unchanged.', 'tendr' );
		self::note( $order, $event, $text . ' ' . $details );
		return 'applied';
	}

	/**
	 * `checkout.session.expired`: Cancelled (WooCommerce releases the stock) when the order's
	 * current session expired with no payment and the order is still pending.
	 *
	 * @param WC_Order $order Order.
	 * @param array    $event Event.
	 * @param array    $view  Session view.
	 * @return string
	 */
	private static function on_expired( WC_Order $order, array $event, array $view ): string {
		$payments = isset( $view['payments'] ) && is_array( $view['payments'] ) ? $view['payments'] : array();
		if (
			'EXPIRED' !== ( $view['status'] ?? null )
			|| array() !== $payments
			|| (string) $order->get_meta( Tendr_Gateway::META_SESSION_ID ) !== $view['id']
			|| ! $order->has_status( 'pending' )
		) {
			return 'noop';
		}
		$order->update_status( 'cancelled', self::prefix( $event ) . __( 'The crypto checkout expired without a payment.', 'tendr' ) );
		return 'applied';
	}

	// ------------------------------------------------------------------ state helpers.

	/**
	 * The event's payment in the session view, or null.
	 *
	 * @param array $view Session view.
	 * @param array $data Event data.
	 */
	private static function payment_of( array $view, array $data ): ?array {
		$id = isset( $data['payment_id'] ) && is_string( $data['payment_id'] ) ? $data['payment_id'] : '';
		foreach ( ( isset( $view['payments'] ) && is_array( $view['payments'] ) ) ? $view['payments'] : array() as $payment ) {
			if ( is_array( $payment ) && '' !== $id && ( $payment['id'] ?? null ) === $id ) {
				return $payment;
			}
		}
		return null;
	}

	/**
	 * Whether a payment view settled (on time).
	 *
	 * @param array $payment Payment view.
	 */
	private static function is_settled( array $payment ): bool {
		return in_array( $payment['status'] ?? null, self::SETTLED_PAYMENT_STATUSES, true )
			&& ! empty( $payment['settled_at'] )
			&& true !== ( $payment['is_late'] ?? null );
	}

	/**
	 * Whether the order counts as paid (Processing, Completed, or another paid status).
	 *
	 * @param WC_Order $order Order.
	 */
	private static function is_paid( WC_Order $order ): bool {
		return $order->has_status( wc_get_is_paid_statuses() );
	}

	/**
	 * Whether the shopper can still pay the order's current session.
	 *
	 * @param WC_Order $order Order.
	 * @param array    $event Event.
	 * @param array    $view  Session view.
	 */
	private static function can_still_pay( WC_Order $order, array $event, array $view ): bool {
		if ( 'PENDING_DEPOSIT' !== ( $view['status'] ?? null ) || (string) $order->get_meta( Tendr_Gateway::META_SESSION_ID ) !== $view['id'] ) {
			return false;
		}
		$expires = isset( $view['expires_at'] ) && is_string( $view['expires_at'] ) ? strtotime( $view['expires_at'] ) : false;
		return false !== $expires && $expires > time();
	}

	/**
	 * Keep the origin asset an event names, for notes on later events that omit it.
	 *
	 * @param WC_Order $order Order.
	 * @param array    $data  Event data.
	 */
	private static function remember_asset( WC_Order $order, array $data ): void {
		$payment = isset( $data['payment_id'] ) && is_string( $data['payment_id'] ) ? $data['payment_id'] : '';
		$asset   = isset( $data['origin_asset'] ) && is_string( $data['origin_asset'] ) ? $data['origin_asset'] : '';
		if ( '' === $payment || '' === $asset || ! preg_match( '/^[A-Za-z0-9:._\-]{1,128}$/', $asset ) ) {
			return;
		}
		$assets = $order->get_meta( self::META_ASSETS );
		$assets = is_array( $assets ) ? $assets : array();
		if ( ( $assets[ $payment ] ?? null ) === $asset ) {
			return;
		}
		$assets[ $payment ] = $asset;
		$order->update_meta_data( self::META_ASSETS, array_slice( $assets, -20, null, true ) );
		$order->save_meta_data();
	}

	// ------------------------------------------------------------------ notes.

	/**
	 * Add a private order note (prefixed "[Test] " for a test-mode event).
	 *
	 * @param WC_Order $order Order.
	 * @param array    $event Event.
	 * @param string   $text  Note HTML (dynamic parts already escaped).
	 */
	public static function note( WC_Order $order, array $event, string $text ): void {
		$order->add_order_note( self::prefix( $event ) . $text );
	}

	/**
	 * "[Test] " for a test-mode event, else "".
	 *
	 * @param array $event Event.
	 */
	public static function prefix( array $event ): string {
		return empty( $event['livemode'] ) ? __( '[Test]', 'tendr' ) . ' ' : '';
	}

	/**
	 * "Paid $49.00 with <token> on <Chain>. Transaction: <explorer link>. tendr payment pay_…."
	 *
	 * @param WC_Order $order   Order.
	 * @param array    $event   Event.
	 * @param array    $view    Session view.
	 * @param array    $payment Payment view.
	 */
	public static function payment_details( WC_Order $order, array $event, array $view, array $payment ): string {
		$asset = isset( $event['data']['origin_asset'] ) && is_string( $event['data']['origin_asset'] ) ? $event['data']['origin_asset'] : '';
		if ( '' === $asset ) {
			$assets = $order->get_meta( self::META_ASSETS );
			$asset  = is_array( $assets ) && isset( $assets[ $payment['id'] ?? '' ] ) ? (string) $assets[ $payment['id'] ] : '';
		}
		$chain = isset( $payment['sender_chain'] ) && is_string( $payment['sender_chain'] ) ? $payment['sender_chain'] : '';
		$usd   = isset( $payment['amount_in_usd'] ) && is_string( $payment['amount_in_usd'] ) ? self::usd( $payment['amount_in_usd'] ) : null;

		$parts = array();
		$paid  = null !== $usd
			/* translators: %s: amount in US dollars, e.g. $49.00. */
			? sprintf( __( 'Amount: %s', 'tendr' ), $usd )
			: ( isset( $payment['amount_received'] ) && is_string( $payment['amount_received'] )
				/* translators: %s: amount in the token's base units. */
				? sprintf( __( 'Amount: %s (token base units)', 'tendr' ), $payment['amount_received'] )
				: '' );
		if ( '' !== $paid ) {
			$parts[] = esc_html( $paid );
		}
		if ( '' !== $asset ) {
			/* translators: %s: token (asset id). */
			$parts[] = esc_html( sprintf( __( 'Token: %s', 'tendr' ), $asset ) );
		}
		if ( '' !== $chain ) {
			/* translators: %s: chain name, e.g. Ethereum. */
			$parts[] = esc_html( sprintf( __( 'Chain: %s', 'tendr' ), self::chain_name( $chain ) ) );
		}
		$hash = isset( $payment['origin_tx_hash'] ) && is_string( $payment['origin_tx_hash'] ) ? $payment['origin_tx_hash'] : '';
		if ( '' !== $hash ) {
			$url     = self::explorer_url( $chain, $hash, ! empty( $event['livemode'] ) );
			$parts[] = esc_html__( 'Transaction:', 'tendr' ) . ' ' . ( null !== $url
				? '<a href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $url ) . '</a>'
				: esc_html( $hash ) );
		}
		/* translators: %s: tendr payment id. */
		$parts[] = esc_html( sprintf( __( 'tendr payment %s', 'tendr' ), (string) ( $payment['id'] ?? '' ) ) );
		return implode( '. ', $parts ) . '.';
	}

	/**
	 * "Converted ₦78,500.00 → $49.00 at 1 USD = 1,602.04 NGN (source, time)." or null.
	 *
	 * @param array $view Session view.
	 */
	public static function fx_line( array $view ): ?string {
		$fx = isset( $view['fx'] ) && is_array( $view['fx'] ) ? $view['fx'] : null;
		if ( null === $fx || empty( $view['original_amount'] ) || empty( $view['original_currency'] ) || empty( $fx['rate'] ) ) {
			return null;
		}
		$currency = (string) $view['original_currency'];
		$symbol   = html_entity_decode( get_woocommerce_currency_symbol( $currency ), ENT_QUOTES, 'UTF-8' );
		$original = ( '' !== $symbol && $symbol !== $currency ? $symbol : $currency . ' ' ) . self::group( (string) $view['original_amount'] );
		$usd      = self::usd( (string) ( $view['amount'] ?? '' ) ) ?? (string) ( $view['amount'] ?? '' );
		$when     = isset( $fx['as_of'] ) && false !== strtotime( (string) $fx['as_of'] ) ? gmdate( 'Y-m-d H:i', (int) strtotime( (string) $fx['as_of'] ) ) . ' UTC' : '';
		$source   = trim( (string) ( $fx['source'] ?? '' ) . ( '' !== $when ? ', ' . $when : '' ), ', ' );
		return esc_html(
			sprintf(
				/* translators: 1: original amount, 2: USD amount, 3: rate, 4: original currency code. */
				__( 'Converted %1$s → %2$s at 1 USD = %3$s %4$s', 'tendr' ),
				$original,
				$usd,
				self::group( (string) $fx['rate'] ),
				$currency
			) . ( '' !== $source ? ' (' . $source . ')' : '' ) . '.'
		);
	}

	/**
	 * The overpayment sentence, or "".
	 *
	 * @param array $payment Payment view.
	 */
	private static function overpaid_line( array $payment ): string {
		if ( empty( $payment['overpaid_amount'] ) || '0' === (string) $payment['overpaid_amount'] ) {
			return '';
		}
		if ( true === ( $payment['kept_small_overpayment'] ?? null ) ) {
			return ' ' . esc_html__( 'The shopper paid slightly more than the order total; the extra (under $1 after network costs) was kept.', 'tendr' );
		}
		return ' ' . esc_html__( 'The shopper paid more than the order total; tendr is returning the extra to them.', 'tendr' );
	}

	/**
	 * A link to the tendr review queue.
	 */
	public static function review_link(): string {
		$url = Tendr_Plugin::checkout_base() . '/dashboard/review';
		return esc_html__( 'Review queue:', 'tendr' ) . ' <a href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $url ) . '</a>';
	}

	/**
	 * A block-explorer link for a transaction, or null (unknown chain; test mode has NEAR
	 * testnet only, other test-mode chains are simulated).
	 *
	 * @param string $chain    1Click chain id.
	 * @param string $hash     Transaction hash.
	 * @param bool   $livemode Live mode.
	 */
	public static function explorer_url( string $chain, string $hash, bool $livemode ): ?string {
		$explorers = array(
			'near'      => array( 'https://nearblocks.io/txns/', 'https://testnet.nearblocks.io/txns/' ),
			'eth'       => array( 'https://etherscan.io/tx/', null ),
			'base'      => array( 'https://basescan.org/tx/', null ),
			'arb'       => array( 'https://arbiscan.io/tx/', null ),
			'arbitrum'  => array( 'https://arbiscan.io/tx/', null ),
			'pol'       => array( 'https://polygonscan.com/tx/', null ),
			'polygon'   => array( 'https://polygonscan.com/tx/', null ),
			'bsc'       => array( 'https://bscscan.com/tx/', null ),
			'op'        => array( 'https://optimistic.etherscan.io/tx/', null ),
			'optimism'  => array( 'https://optimistic.etherscan.io/tx/', null ),
			'avax'      => array( 'https://snowtrace.io/tx/', null ),
			'avalanche' => array( 'https://snowtrace.io/tx/', null ),
			'gnosis'    => array( 'https://gnosisscan.io/tx/', null ),
			'sol'       => array( 'https://solscan.io/tx/', null ),
			'tron'      => array( 'https://tronscan.org/#/transaction/', null ),
			'btc'       => array( 'https://mempool.space/tx/', null ),
		);
		$key       = strtolower( $chain );
		if ( ! isset( $explorers[ $key ] ) || ! preg_match( '/^[A-Za-z0-9]{1,128}$/', $hash ) ) {
			return null;
		}
		$base = $explorers[ $key ][ $livemode ? 0 : 1 ];
		return null === $base ? null : $base . $hash;
	}

	/**
	 * A plain chain name for a 1Click chain id ("arb" → "Arbitrum").
	 *
	 * @param string $chain Chain id.
	 */
	public static function chain_name( string $chain ): string {
		$names = array(
			'eth'     => 'Ethereum',
			'base'    => 'Base',
			'arb'     => 'Arbitrum',
			'op'      => 'Optimism',
			'pol'     => 'Polygon',
			'bsc'     => 'BNB Chain',
			'avax'    => 'Avalanche',
			'gnosis'  => 'Gnosis',
			'bera'    => 'Berachain',
			'sol'     => 'Solana',
			'tron'    => 'Tron',
			'btc'     => 'Bitcoin',
			'near'    => 'NEAR',
			'ton'     => 'TON',
			'doge'    => 'Dogecoin',
			'xrp'     => 'XRP Ledger',
			'zec'     => 'Zcash',
			'sui'     => 'Sui',
			'aptos'   => 'Aptos',
			'stellar' => 'Stellar',
		);
		return $names[ strtolower( $chain ) ] ?? strtoupper( $chain );
	}

	/**
	 * A USD decimal string → "$1,234.57" (rounded up to the cent), or null.
	 *
	 * @param string $amount Decimal string.
	 */
	public static function usd( string $amount ): ?string {
		if ( ! preg_match( '/^(\d+)(?:\.(\d+))?$/', trim( $amount ), $m ) ) {
			return null;
		}
		$frac  = $m[2] ?? '';
		$cents = substr( $frac . '00', 0, 2 );
		$whole = ltrim( $m[1], '0' );
		$whole = '' === $whole ? '0' : $whole;
		if ( preg_match( '/[1-9]/', substr( $frac, 2 ) ) ) {
			// Round up by one cent, with carry, on strings (no float).
			$n     = $whole . $cents;
			$i     = strlen( $n ) - 1;
			$carry = 1;
			while ( $carry && $i >= 0 ) {
				$d       = (int) $n[ $i ] + 1;
				$n[ $i ] = (string) ( $d % 10 );
				$carry   = intdiv( $d, 10 );
				--$i;
			}
			$n     = ( $carry ? '1' : '' ) . $n;
			$whole = substr( $n, 0, -2 );
			$cents = substr( $n, -2 );
		}
		return '$' . self::group( $whole ) . '.' . $cents;
	}

	/**
	 * "78500.00" → "78,500.00" (thousands grouped, decimals as given).
	 *
	 * @param string $decimal Decimal string.
	 */
	private static function group( string $decimal ): string {
		if ( ! preg_match( '/^(\d+)(\.\d+)?$/', trim( $decimal ), $m ) ) {
			return $decimal;
		}
		return (string) preg_replace( '/\B(?=(\d{3})+(?!\d))/', ',', $m[1] ) . ( $m[2] ?? '' );
	}

	// ------------------------------------------------------------------ plumbing.

	/**
	 * Log an event that changed nothing, without secrets or personal data.
	 *
	 * @param array  $event  Event.
	 * @param string $reason Why.
	 */
	private static function log( array $event, string $reason ): void {
		$entry = array(
			'event_id'     => (string) ( $event['id'] ?? '' ),
			'type'         => (string) ( $event['type'] ?? '' ),
			'livemode'     => ! empty( $event['livemode'] ),
			'external_ref' => isset( $event['data']['external_ref'] ) && is_string( $event['data']['external_ref'] ) ? $event['data']['external_ref'] : null,
			'reason'       => $reason,
		);
		if ( function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->info( 'tendr webhook ignored: ' . wp_json_encode( $entry ), array( 'source' => 'tendr' ) );
		}
		/**
		 * A verified webhook event that changed nothing (unknown order, mismatch, not confirmed).
		 *
		 * @param array $entry event_id, type, livemode, external_ref, reason.
		 */
		do_action( 'tendr_webhook_log', $entry );
	}

	/**
	 * HTTP status of an API error.
	 *
	 * @param WP_Error $error Error.
	 */
	private static function status_of( WP_Error $error ): int {
		$data = $error->get_error_data();
		return is_array( $data ) && isset( $data['status'] ) ? (int) $data['status'] : 0;
	}

	/**
	 * Take the per-order lock that serialises every tendr change to one order (webhook deliveries
	 * and refund requests).
	 *
	 * @param int $order_id Order id.
	 */
	public static function lock_order( int $order_id ): bool {
		global $wpdb;
		return self::lock( 'tendr_order_' . $wpdb->prefix . $order_id );
	}

	/**
	 * Release lock_order().
	 *
	 * @param int $order_id Order id.
	 */
	public static function unlock_order( int $order_id ): void {
		global $wpdb;
		self::unlock( 'tendr_order_' . $wpdb->prefix . $order_id );
	}

	/**
	 * A per-order MySQL named lock, so two deliveries never update one order at once.
	 *
	 * @param string $name Lock name.
	 */
	private static function lock( string $name ): bool {
		global $wpdb;
		return '1' === (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $name, self::LOCK_WAIT ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * Release a lock from lock().
	 *
	 * @param string $name Lock name.
	 */
	private static function unlock( string $name ): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $name ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}
}
