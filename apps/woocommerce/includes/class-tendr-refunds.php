<?php
/**
 * Refunds from the WooCommerce order screen (spec §7).
 *
 * A refund clicked in WooCommerce never moves money by itself: it becomes a signer-approved
 * proposal in tendr (`POST /v1/refunds`). The money leaves only once the store's signers approve
 * it, and tendr then sends `refund.sent`.
 *
 * Pending representation: the WooCommerce refund is recorded only on `refund.sent`. While the
 * request waits, it lives in order meta (`_tendr_refunds`) with an order note and a box on the
 * order screen. WooCommerce has no "pending" refund: any refund it stores counts in the order's
 * totals at once, and creating one that covers the whole order marks the order Refunded and emails
 * the customer. So `process_refund()` answers WooCommerce with success (the admin sees no error),
 * and the refund row WooCommerce created for the request is withdrawn before the request ends:
 * the status change, the customer email and the restock are held back for it. On `refund.sent`
 * the refund is created again with the same amount, reason, line items and restock choice; on
 * `refund.cancelled` / `refund.failed` there is nothing to undo. The order's totals therefore
 * always equal what actually left the store's account.
 *
 * Order meta `_tendr_refunds`: WooCommerce refund id (the `external_ref` `wc_refund_<id>`) =>
 * - `refund_id`    tendr refund id (`ref_…`; '' while unconfirmed);
 * - `state`        'pending' (awaiting signers) | 'review' (a person must act in tendr first) |
 *                  'unconfirmed' (tendr's answer was lost) | 'sent' | 'cancelled' | 'failed';
 * - `amount`       in the order currency, as WooCommerce formatted it;
 * - `reason`, `line_items`, `restock`, `payment_id`, `mode`, `requested_at`;
 * - `wc_refund_id` the WooCommerce refund recorded on `refund.sent`.
 * The recorded WooCommerce refund carries `_tendr_refund_id` and `_tendr_refund_state` = 'sent'.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Store refunds.
 */
final class Tendr_Refunds {

	const META              = '_tendr_refunds';
	const REFUND_META_ID    = '_tendr_refund_id';
	const REFUND_META_STATE = '_tendr_refund_state';

	/** States whose amount is still on its way out (counted against what can be refunded). */
	const OPEN_STATES = array( 'pending', 'review' );

	/** API errors that may hide a refund tendr did create (its answer was lost). */
	const AMBIGUOUS_CODES = array( 'tendr_unreachable', 'tendr_bad_response', 'IDEMPOTENCY_IN_PROGRESS' );

	/**
	 * The refund WooCommerce is creating with "refund via tendr", and its arguments.
	 *
	 * @var array{refund: WC_Order_Refund, args: array}|null
	 */
	private static ?array $creating = null;

	/**
	 * WooCommerce refunds sent to tendr in this request and withdrawn from WooCommerce: id => order id.
	 *
	 * @var array<int, int>
	 */
	private static array $withheld = array();

	/**
	 * Orders whose refund row was withdrawn in this request (for emails sent at shutdown).
	 *
	 * @var array<int, true>
	 */
	private static array $withdrawn_orders = array();

	/**
	 * Hooks.
	 */
	public static function register(): void {
		add_action( 'woocommerce_create_refund', array( self::class, 'capture' ), 10, 2 );
		add_filter( 'woocommerce_can_restock_refunded_items', array( self::class, 'filter_can_restock' ), 10, 2 );
		add_filter( 'woocommerce_order_is_partially_refunded', array( self::class, 'filter_is_partially_refunded' ), 10, 3 );
		add_filter( 'woocommerce_order_fully_refunded_status', array( self::class, 'filter_fully_refunded_status' ), 10, 3 );
		add_filter( 'woocommerce_email_enabled_customer_refunded_order', array( self::class, 'filter_refund_email' ), 10, 3 );
		add_filter( 'woocommerce_email_enabled_customer_partially_refunded_order', array( self::class, 'filter_refund_email' ), 10, 3 );
		add_action( 'woocommerce_order_refunded', array( self::class, 'withdraw' ), PHP_INT_MAX, 2 );
		add_action( 'woocommerce_admin_order_data_after_order_details', array( self::class, 'render_pending' ) );
	}

	// ------------------------------------------------------------------ requesting.

	/**
	 * `woocommerce_create_refund`: remember the refund WooCommerce is about to ask tendr for.
	 *
	 * @param WC_Order_Refund $refund Refund (saved right after this action).
	 * @param array           $args   wc_create_refund() arguments.
	 */
	public static function capture( $refund, $args ): void {
		if ( ! $refund instanceof WC_Order_Refund || ! is_array( $args ) || empty( $args['refund_payment'] ) ) {
			return;
		}
		$order = wc_get_order( $refund->get_parent_id() );
		if ( $order instanceof WC_Order && Tendr_Gateway::ID === $order->get_payment_method() ) {
			self::$creating = array(
				'refund' => $refund,
				'args'   => $args,
			);
		}
	}

	/**
	 * Ask tendr for a refund (Tendr_Gateway::process_refund()).
	 *
	 * @param int        $order_id Order id.
	 * @param float|null $amount   Amount in the order currency.
	 * @param string     $reason   Reason.
	 * @return true|WP_Error True once tendr has the request (it is pending, not done).
	 */
	public static function request( $order_id, $amount, $reason ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return new WP_Error( 'tendr_refund_forbidden', __( 'You are not allowed to refund orders.', 'tendr' ) );
		}
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || ! self::payment_id( $order ) ) {
			return new WP_Error( 'tendr_refund_unavailable', __( 'This order was not paid through tendr, so tendr cannot refund it.', 'tendr' ) );
		}
		$refund = self::$creating['refund'] ?? null;
		if ( ! $refund instanceof WC_Order_Refund || $refund->get_parent_id() !== $order->get_id() || $refund->get_id() <= 0 ) {
			return new WP_Error( 'tendr_refund_context', __( 'Refund this order from its order screen.', 'tendr' ) );
		}
		$args      = self::$creating['args'];
		$wc_id     = $refund->get_id();
		$plain     = self::plain( wc_format_decimal( (string) $amount, wc_get_price_decimals() ) );
		$formatted = wc_format_decimal( (string) $amount, wc_get_price_decimals() );
		if ( '0' === $plain || '' === $plain || ! preg_match( '/^\d+(\.\d+)?$/', $plain ) ) {
			return new WP_Error( 'tendr_refund_amount', __( 'Enter an amount to refund.', 'tendr' ) );
		}

		if ( ! Tendr_Order_Sync::lock_order( $order->get_id() ) ) {
			return new WP_Error( 'tendr_refund_busy', __( 'This order is being updated by tendr right now. Try the refund again in a moment.', 'tendr' ) );
		}
		try {
			$order    = wc_get_order( $order->get_id() );
			$requests = self::requests( $order );

			// WooCommerce does not count the refunds waiting in tendr; together they may not exceed
			// what is left (its own total already counts this new refund).
			$open      = (float) self::pending_total( $order );
			$remaining = self::remaining( $order );
			if ( round( $open - $remaining, wc_get_price_decimals() ) > 0 ) {
				return new WP_Error(
					'tendr_refund_exceeds_pending',
					sprintf(
						/* translators: 1: amount awaiting approval, 2: amount that can still be refunded. */
						__( 'Refunds of %1$s for this order are already awaiting approval in tendr, so at most %2$s more can be refunded now.', 'tendr' ),
						self::money( $order, (string) $open ),
						self::money( $order, (string) max( 0, $remaining + (float) $formatted - $open ) )
					)
				);
			}

			$mode         = self::order_mode( $order );
			$external_ref = 'wc_refund_' . $wc_id;
			$body         = array(
				'payment'      => self::payment_id( $order ),
				'amount'       => $plain,
				'currency'     => $order->get_currency(),
				'reason'       => '',
				'external_ref' => $external_ref,
			);
			$reason       = trim( wp_strip_all_tags( (string) $reason ) );
			if ( '' !== $reason ) {
				$body['reason'] = mb_substr( $reason, 0, 500 );
			} else {
				unset( $body['reason'] );
			}

			$record = array(
				'refund_id'    => '',
				'state'        => 'unconfirmed',
				'amount'       => $formatted,
				'reason'       => $reason,
				'line_items'   => isset( $args['line_items'] ) && is_array( $args['line_items'] ) ? $args['line_items'] : array(),
				'restock'      => ! empty( $args['restock_items'] ),
				'payment_id'   => $body['payment'],
				'mode'         => $mode,
				'requested_at' => time(),
				'wc_refund_id' => 0,
			);
			$prefix = 'test' === $mode ? __( '[Test]', 'tendr' ) . ' ' : '';

			$result = Tendr_Api_Client::request( 'POST', '/v1/refunds', $body, $mode, array( 'Idempotency-Key' => $external_ref ) );
			if ( is_wp_error( $result ) ) {
				if ( ! self::is_ambiguous( $result ) ) {
					return new WP_Error( 'tendr_refund_refused', self::refusal_message( $result ) );
				}
				// tendr may have the request: keep it, so its events are matched when they come.
				$requests[ $wc_id ] = $record;
				self::save_requests( $order, $requests );
				$order->add_order_note(
					$prefix . esc_html(
						sprintf(
							/* translators: 1: amount, 2: refund reference. */
							__( 'tendr could not confirm the refund request of %1$s (%2$s). Check the tendr dashboard before refunding again: if tendr received it, this order is updated when the refund is sent.', 'tendr' ),
							self::money( $order, $formatted ),
							$external_ref
						)
					)
				);
				return new WP_Error(
					'tendr_refund_unconfirmed',
					__( 'tendr did not confirm the refund request, so nothing is recorded here yet. Check the tendr dashboard before refunding again.', 'tendr' )
				);
			}//end if

			$tendr_id = isset( $result['id'] ) && is_string( $result['id'] ) && preg_match( '/^ref_[A-Za-z0-9]{1,64}$/', $result['id'] ) ? $result['id'] : '';
			if ( '' === $tendr_id ) {
				$requests[ $wc_id ] = $record;
				self::save_requests( $order, $requests );
				return new WP_Error( 'tendr_refund_unconfirmed', __( 'tendr sent a response this plugin could not read. Check the tendr dashboard before refunding again.', 'tendr' ) );
			}
			$review              = 'review' === ( $result['status'] ?? null );
			$record['refund_id'] = $tendr_id;
			$record['state']     = $review ? 'review' : 'pending';
			$requests[ $wc_id ]  = $record;
			self::save_requests( $order, $requests );

			$money = self::money( $order, $formatted );
			if ( $review ) {
				$note = esc_html(
					sprintf(
						/* translators: %s: amount. */
						__( 'Refund of %s is waiting for manual review in tendr before it can be approved. Refunds are paid in your settlement asset: when the shopper paid from another chain or from an exchange, someone on your team must choose the route or the address in tendr first. Nothing has been refunded yet.', 'tendr' ),
						$money
					)
				) . ' ' . Tendr_Order_Sync::review_link();
			} else {
				$url  = Tendr_Plugin::checkout_base() . '/dashboard/approvals';
				$note = esc_html(
					sprintf(
						/* translators: %s: amount. */
						__( 'Refund of %s awaiting approval in tendr. Nothing is refunded until your store\'s signers approve it.', 'tendr' ),
						$money
					)
				) . ' ' . esc_html__( 'Approve it:', 'tendr' ) . ' <a href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $url ) . '</a>';
			}
			$order->add_order_note( $prefix . $note );

			// Withdraw WooCommerce's refund row at the end of wc_create_refund(): it is recorded again
			// on refund.sent.
			self::$withheld[ $wc_id ] = $order->get_id();
			return true;
		} finally {
			Tendr_Order_Sync::unlock_order( $order->get_id() );
		}//end try
	}

	/**
	 * `woocommerce_order_refunded` (last): delete the refund row of a request now waiting in tendr.
	 *
	 * @param int $order_id  Order id.
	 * @param int $refund_id Refund id.
	 */
	public static function withdraw( $order_id, $refund_id ): void {
		self::$creating = null;
		$refund_id      = (int) $refund_id;
		if ( ! isset( self::$withheld[ $refund_id ] ) ) {
			return;
		}
		unset( self::$withheld[ $refund_id ] );
		self::$withdrawn_orders[ (int) $order_id ] = true;
		$refund                                    = wc_get_order( $refund_id );
		if ( $refund instanceof WC_Order_Refund ) {
			$refund->delete( true );
		}
		// Totals WooCommerce cached while the row existed (total refunded, the refund list).
		WC_Cache_Helper::invalidate_cache_group( 'orders' );
	}

	/**
	 * `woocommerce_can_restock_refunded_items`: no restock while the refund waits in tendr (it
	 * happens on refund.sent, if it was asked for).
	 *
	 * @param bool     $can   Whether to restock.
	 * @param WC_Order $order Order.
	 */
	public static function filter_can_restock( $can, $order ) {
		if ( $order instanceof WC_Order && in_array( $order->get_id(), self::$withheld, true ) ) {
			return false;
		}
		return $can;
	}

	/**
	 * `woocommerce_order_is_partially_refunded`: a withheld refund never takes the "fully refunded"
	 * branch (no Refunded status).
	 *
	 * @param bool $partial   Partially refunded.
	 * @param int  $order_id  Order id.
	 * @param int  $refund_id Refund id.
	 */
	public static function filter_is_partially_refunded( $partial, $order_id, $refund_id ) {
		return isset( self::$withheld[ (int) $refund_id ] ) ? true : $partial;
	}

	/**
	 * `woocommerce_order_fully_refunded_status`: never Refunded for a withheld refund.
	 *
	 * @param string|false $status    Status.
	 * @param int          $order_id  Order id.
	 * @param int          $refund_id Refund id.
	 */
	public static function filter_fully_refunded_status( $status, $order_id, $refund_id ) {
		return isset( self::$withheld[ (int) $refund_id ] ) ? false : $status;
	}

	/**
	 * The customer "refunded" emails: never for a refund that only waits in tendr.
	 *
	 * @param bool     $enabled Enabled.
	 * @param mixed    $subject The order.
	 * @param WC_Email $email   Email.
	 */
	public static function filter_refund_email( $enabled, $subject, $email = null ) {
		if ( ! $enabled ) {
			return $enabled;
		}
		$refund = is_object( $email ) && isset( $email->refund ) ? $email->refund : null;
		if ( $refund instanceof WC_Order_Refund ) {
			return isset( self::$withheld[ $refund->get_id() ] ) ? false : $enabled;
		}
		// Sent late (deferred emails): the withdrawn refund no longer exists.
		if ( $subject instanceof WC_Order && isset( self::$withdrawn_orders[ $subject->get_id() ] ) ) {
			return false;
		}
		return $enabled;
	}

	// ------------------------------------------------------------------ events.

	/**
	 * A refund event, under the order lock, after the session re-read (Tendr_Order_Sync::apply()).
	 * The re-read decides: `refund.sent` is applied only when the session shows the refund
	 * confirmed, and a sent refund is final whatever arrives later.
	 *
	 * @param WC_Order $order Order.
	 * @param array    $event Verified event.
	 * @param array    $view  The session as re-read from the API.
	 * @return string|WP_Error 'applied' | 'noop', or an error to retry.
	 */
	public static function apply_event( WC_Order $order, array $event, array $view ) {
		$type = (string) $event['type'];
		$data = $event['data'];
		if ( 'payment.refunded' === $type ) {
			// The last store refund of the payment was sent: refund.sent already recorded it.
			return 'noop';
		}
		$ext = isset( $data['refund_external_ref'] ) && is_string( $data['refund_external_ref'] ) ? $data['refund_external_ref'] : '';
		if ( ! preg_match( '/^wc_refund_([1-9][0-9]{0,19})$/', $ext, $m ) ) {
			return 'noop';
		}
		$key      = (int) $m[1];
		$requests = self::requests( $order );
		$req      = $requests[ $key ] ?? null;
		$tendr_id = isset( $data['refund_id'] ) && is_string( $data['refund_id'] ) ? $data['refund_id'] : '';
		$pay_id   = isset( $data['payment_id'] ) && is_string( $data['payment_id'] ) ? $data['payment_id'] : '';
		if ( null === $req || '' === $tendr_id || $pay_id !== $req['payment_id'] ) {
			return 'noop';
		}
		if ( '' !== $req['refund_id'] && $req['refund_id'] !== $tendr_id ) {
			return 'noop';
		}
		$row = self::refund_in_view( $view, $pay_id, $tendr_id );
		if ( null === $row ) {
			return 'noop';
		}
		$adopted = '' === $req['refund_id'];
		if ( $adopted ) {
			// An unconfirmed request: tendr did receive it.
			$req['refund_id'] = $tendr_id;
			$req['state']     = 'pending';
		}
		$sent = 'confirmed' === ( $row['status'] ?? null );

		switch ( $type ) {
			case 'refund.sent':
				if ( 'sent' === $req['state'] ) {
					return 'noop';
				}
				if ( ! $sent ) {
					return self::finish( $order, $requests, $key, $req, $adopted );
				}
				return self::record_sent( $order, $event, $requests, $key, $req, $row );

			case 'refund.cancelled':
			case 'refund.failed':
				if ( 'sent' === $req['state'] || $sent || in_array( $req['state'], array( 'cancelled', 'failed' ), true ) ) {
					return self::finish( $order, $requests, $key, $req, $adopted );
				}
				$req['state'] = 'refund.cancelled' === $type ? 'cancelled' : 'failed';
				$money        = self::money( $order, $req['amount'] );
				$text         = 'cancelled' === $req['state']
					/* translators: %s: amount. */
					? sprintf( __( 'The refund of %s was not approved in tendr (it was rejected or expired). Nothing was refunded and the order totals are unchanged.', 'tendr' ), $money )
					/* translators: %s: amount. */
					: sprintf( __( 'The refund of %s could not be sent by tendr. Nothing was refunded and the order totals are unchanged; refund again to retry.', 'tendr' ), $money );
				$requests[ $key ] = $req;
				self::save_requests( $order, $requests );
				Tendr_Order_Sync::note( $order, $event, esc_html( $text ) );
				return 'applied';

			case 'refund.pending':
				if ( 'review' !== $req['state'] ) {
					return self::finish( $order, $requests, $key, $req, $adopted );
				}
				$req['state']     = 'pending';
				$requests[ $key ] = $req;
				self::save_requests( $order, $requests );
				Tendr_Order_Sync::note(
					$order,
					$event,
					/* translators: %s: amount. */
					esc_html( sprintf( __( 'The refund of %s is now awaiting approval by your store\'s signers in tendr.', 'tendr' ), self::money( $order, $req['amount'] ) ) )
				);
				return 'applied';

			case 'refund.needs_address':
				if ( 'pending' !== $req['state'] ) {
					return self::finish( $order, $requests, $key, $req, $adopted );
				}
				$req['state']     = 'review';
				$requests[ $key ] = $req;
				self::save_requests( $order, $requests );
				Tendr_Order_Sync::note(
					$order,
					$event,
					/* translators: %s: amount. */
					esc_html( sprintf( __( 'The refund of %s is waiting for the shopper: they paid from an exchange, and tendr has asked them by email where to receive it.', 'tendr' ), self::money( $order, $req['amount'] ) ) )
				);
				return 'applied';

			default:
				return self::finish( $order, $requests, $key, $req, $adopted );
		}//end switch
	}

	/**
	 * Save an adopted request (if any) and report a no-op.
	 *
	 * @param WC_Order $order    Order.
	 * @param array    $requests All requests.
	 * @param int      $key      This request's WooCommerce refund id.
	 * @param array    $req      This request.
	 * @param bool     $adopted  Whether it was just adopted.
	 */
	private static function finish( WC_Order $order, array $requests, int $key, array $req, bool $adopted ): string {
		if ( $adopted ) {
			$requests[ $key ] = $req;
			self::save_requests( $order, $requests );
		}
		return 'noop';
	}

	/**
	 * Record the WooCommerce refund for a sent tendr refund.
	 *
	 * @param WC_Order $order    Order.
	 * @param array    $event    Event.
	 * @param array    $requests All requests.
	 * @param int      $key      This request's WooCommerce refund id.
	 * @param array    $req      This request.
	 * @param array    $row      The refund in the session view.
	 * @return string|WP_Error
	 */
	private static function record_sent( WC_Order $order, array $event, array $requests, int $key, array $req, array $row ) {
		$money     = self::money( $order, $req['amount'] );
		$remaining = self::remaining( $order );
		if ( round( (float) $req['amount'] - $remaining, wc_get_price_decimals() ) > 0 ) {
			// The money left, but WooCommerce has less left to refund (e.g. a manual refund meanwhile).
			$req['state']     = 'sent';
			$requests[ $key ] = $req;
			self::save_requests( $order, $requests );
			Tendr_Order_Sync::note(
				$order,
				$event,
				/* translators: %s: amount. */
				esc_html( sprintf( __( 'tendr sent the refund of %s, but WooCommerce could not record it because the order has less left to refund. Record it by hand so the totals match.', 'tendr' ), $money ) )
			);
			return 'applied';
		}

		$refund = wc_create_refund(
			array(
				'order_id'       => $order->get_id(),
				'amount'         => $req['amount'],
				'reason'         => '' !== $req['reason'] ? $req['reason'] : null,
				'line_items'     => $req['line_items'],
				'refund_payment' => false,
				'restock_items'  => ! empty( $req['restock'] ),
			)
		);
		if ( is_wp_error( $refund ) ) {
			return new WP_Error( 'tendr_refund_record_failed', $refund->get_error_message() );
		}
		$refund->update_meta_data( self::REFUND_META_ID, $req['refund_id'] );
		$refund->update_meta_data( self::REFUND_META_STATE, 'sent' );
		$refund->save();

		$order               = wc_get_order( $order->get_id() );
		$req['state']        = 'sent';
		$req['wc_refund_id'] = $refund->get_id();
		$requests[ $key ]    = $req;
		self::save_requests( $order, $requests );

		/* translators: %s: amount. */
		$text  = esc_html( sprintf( __( 'Refund of %s sent by tendr.', 'tendr' ), $money ) );
		$chain = isset( $row['destination_chain'] ) && is_string( $row['destination_chain'] ) ? $row['destination_chain'] : '';
		$hash  = isset( $row['refund_tx_hash'] ) && is_string( $row['refund_tx_hash'] ) ? $row['refund_tx_hash'] : '';
		if ( '' !== $hash ) {
			$url   = Tendr_Order_Sync::explorer_url( $chain, $hash, ! empty( $event['livemode'] ) );
			$text .= ' ' . esc_html__( 'Transaction:', 'tendr' ) . ' ' . ( null !== $url
				? '<a href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $url ) . '</a>'
				: esc_html( $hash ) );
		}
		/* translators: %s: tendr refund id. */
		$text .= ' ' . esc_html( sprintf( __( 'tendr refund %s.', 'tendr' ), $req['refund_id'] ) );
		Tendr_Order_Sync::note( $order, $event, $text );
		return 'applied';
	}

	/**
	 * The refund `$refund_id` of payment `$payment_id` in a session view, or null.
	 *
	 * @param array  $view       Session view.
	 * @param string $payment_id Payment id.
	 * @param string $refund_id  Refund id.
	 */
	private static function refund_in_view( array $view, string $payment_id, string $refund_id ): ?array {
		foreach ( ( isset( $view['payments'] ) && is_array( $view['payments'] ) ) ? $view['payments'] : array() as $payment ) {
			if ( ! is_array( $payment ) || ( $payment['id'] ?? null ) !== $payment_id ) {
				continue;
			}
			foreach ( ( isset( $payment['refunds'] ) && is_array( $payment['refunds'] ) ) ? $payment['refunds'] : array() as $refund ) {
				if ( is_array( $refund ) && ( $refund['id'] ?? null ) === $refund_id ) {
					return $refund;
				}
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ state.

	/**
	 * The order's tendr refund requests, by WooCommerce refund id.
	 *
	 * @param WC_Order $order Order.
	 * @return array<int, array>
	 */
	public static function requests( WC_Order $order ): array {
		$raw = $order->get_meta( self::META );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $id => $req ) {
			if ( is_array( $req ) && (int) $id > 0 ) {
				$out[ (int) $id ] = array_merge(
					array(
						'refund_id'    => '',
						'state'        => 'unconfirmed',
						'amount'       => '0',
						'reason'       => '',
						'line_items'   => array(),
						'restock'      => false,
						'payment_id'   => '',
						'mode'         => 'test',
						'requested_at' => 0,
						'wc_refund_id' => 0,
					),
					$req
				);
			}
		}
		return $out;
	}

	/**
	 * Save the requests.
	 *
	 * @param WC_Order $order    Order.
	 * @param array    $requests By WooCommerce refund id.
	 */
	private static function save_requests( WC_Order $order, array $requests ): void {
		$order->update_meta_data( self::META, $requests );
		$order->save_meta_data();
	}

	/**
	 * What waits in tendr (pending or in review), in the order currency, e.g. "25" or "0".
	 *
	 * @param WC_Order $order Order.
	 */
	public static function pending_total( WC_Order $order ): string {
		$sum = 0.0;
		foreach ( self::requests( $order ) as $req ) {
			if ( in_array( $req['state'], self::OPEN_STATES, true ) ) {
				$sum += (float) $req['amount'];
			}
		}
		return self::plain( wc_format_decimal( $sum, wc_get_price_decimals() ) );
	}

	/**
	 * `woocommerce_admin_order_data_after_order_details`: refunds waiting in tendr.
	 *
	 * @param WC_Order|mixed $order Order being edited.
	 */
	public static function render_pending( $order ): void {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$lines = array();
		foreach ( self::requests( $order ) as $req ) {
			if ( in_array( $req['state'], self::OPEN_STATES, true ) ) {
				$lines[] = 'review' === $req['state']
					/* translators: %s: amount. */
					? sprintf( __( '%s: waiting for review in tendr', 'tendr' ), self::money( $order, $req['amount'] ) )
					/* translators: %s: amount. */
					: sprintf( __( '%s: awaiting approval in tendr', 'tendr' ), self::money( $order, $req['amount'] ) );
			}
		}
		if ( array() === $lines ) {
			return;
		}
		echo '<div class="notice notice-info inline tendr-pending-refunds" style="clear:both;margin:12px 0 0;"><p><strong>'
			. esc_html__( 'Refunds not yet sent (not counted in the totals):', 'tendr' ) . '</strong></p><ul>';
		foreach ( $lines as $line ) {
			echo '<li>' . esc_html( $line ) . '</li>';
		}
		echo '</ul></div>';
	}

	// ------------------------------------------------------------------ helpers.

	/**
	 * The tendr payment that paid the order (its WooCommerce transaction id), or ''.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function payment_id( WC_Order $order ): string {
		$id = (string) $order->get_transaction_id();
		return Tendr_Gateway::ID === $order->get_payment_method() && preg_match( '/^pay_[A-Za-z0-9]{1,64}$/', $id ) ? $id : '';
	}

	/**
	 * The mode the order was paid in, whatever the plugin's mode is now: its key must refund it.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function order_mode( WC_Order $order ): string {
		$paid = (string) $order->get_meta( Tendr_Order_Sync::META_PAID_LIVEMODE );
		if ( 'yes' === $paid || 'no' === $paid ) {
			return 'yes' === $paid ? 'live' : 'test';
		}
		return 'live' === $order->get_meta( Tendr_Gateway::META_MODE ) ? 'live' : 'test';
	}

	/**
	 * What WooCommerce can still refund, read from the store, not from the order's cache: a refund
	 * row WooCommerce deletes after a failed request must not linger in a cached total.
	 *
	 * @param WC_Order $order Order.
	 */
	private static function remaining( WC_Order $order ): float {
		$refunded = (float) $order->get_data_store()->get_total_refunded( $order );
		return (float) wc_format_decimal( (float) $order->get_total() - $refunded, wc_get_price_decimals() );
	}

	/**
	 * "10.00" → "10", "1.230" → "1.23".
	 *
	 * @param string $decimal Decimal string.
	 */
	private static function plain( string $decimal ): string {
		$decimal = trim( $decimal );
		if ( str_contains( $decimal, '.' ) ) {
			$decimal = rtrim( rtrim( $decimal, '0' ), '.' );
		}
		return '' === $decimal ? '0' : $decimal;
	}

	/**
	 * An amount as plain text in the order currency, e.g. "$10.00".
	 *
	 * @param WC_Order $order  Order.
	 * @param string   $amount Amount.
	 */
	private static function money( WC_Order $order, string $amount ): string {
		return html_entity_decode( wp_strip_all_tags( wc_price( (float) $amount, array( 'currency' => $order->get_currency() ) ) ), ENT_QUOTES, 'UTF-8' );
	}

	/**
	 * Whether a failed request may still have created the refund in tendr.
	 *
	 * @param WP_Error $error Error.
	 */
	private static function is_ambiguous( WP_Error $error ): bool {
		$data   = $error->get_error_data();
		$status = is_array( $data ) && isset( $data['status'] ) ? (int) $data['status'] : 0;
		return in_array( $error->get_error_code(), self::AMBIGUOUS_CODES, true ) || $status >= 500;
	}

	/**
	 * The message the admin sees when tendr refused the refund.
	 *
	 * @param WP_Error $error Error.
	 */
	private static function refusal_message( WP_Error $error ): string {
		switch ( $error->get_error_code() ) {
			case 'AMOUNT_EXCEEDS_REFUNDABLE':
				return __( 'This is more than tendr can still refund for this payment (counting refunds already requested), or more than your tendr account holds to cover it with its network cost.', 'tendr' ) . ' ' . $error->get_error_message();
			case 'PAYMENT_NOT_REFUNDABLE':
				return __( 'tendr cannot refund this payment: only a settled payment can be refunded.', 'tendr' );
			case 'UNSUPPORTED_CURRENCY':
				return __( 'tendr can refund this order only in US dollars or in the currency it was paid in.', 'tendr' );
			case 'NOT_FOUND':
				return __( 'tendr does not know this payment for this site. It may have been paid through another connection.', 'tendr' );
			case 'tendr_not_connected':
				return $error->get_error_message();
			default:
				/* translators: %s: error message from tendr. */
				return sprintf( __( 'tendr refused the refund: %s', 'tendr' ), $error->get_error_message() );
		}
	}
}
