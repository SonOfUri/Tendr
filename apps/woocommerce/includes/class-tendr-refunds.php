<?php
/**
 * Refunds from the WooCommerce order screen (spec §7).
 *
 * A refund clicked in WooCommerce never moves money by itself: it becomes a signer-approved
 * proposal in tendr (`POST /v1/refunds`). The money leaves only once the store's signers approve
 * it, and tendr then sends `refund.sent`.
 *
 * The request is made before WooCommerce finishes the refund. `wc_create_refund()` fires
 * `woocommerce_create_refund` before its final save (it has only stored a draft row while
 * totalling it); for a tendr order refunded "via tendr" the plugin asks tendr there, records the
 * request on the order, and throws. WooCommerce then deletes the draft and returns an error whose
 * message is the plugin's ("Refund of $10.00 sent to your Tendr signers for approval…"): no
 * refund hooks, no download revocation, no restock, no status change, no email. The admin sees that message (the order screen's alert, or the REST
 * error), and the order gets a note.
 *
 * WooCommerce has no "pending" refund (a stored refund counts in the totals at once), so the
 * request waits in order meta `_tendr_refunds` and a box on the order screen. On `refund.sent` the
 * WooCommerce refund is created, exactly once, with the stored amount, reason, line items and
 * restock choice; `refund.cancelled` / `refund.failed` leave nothing to undo. The order's totals
 * therefore always equal what actually left the store's account.
 *
 * Order meta `_tendr_refunds`: external_ref `wc_refund_<order id>_<n>` (n from the order counter
 * `_tendr_refund_seq`, taken under the order lock) =>
 * - `refund_id`    tendr refund id (`ref_…`; '' while unconfirmed);
 * - `state`        'pending' (awaiting signers) | 'review' (a person must act in tendr first) |
 *                  'unconfirmed' (tendr's answer was lost) | 'sent' | 'cancelled' | 'failed' |
 *                  'lapsed' (tendr no longer lists it, or never received it) | 'dismissed' (an
 *                  unconfirmed request a store manager dismissed);
 * - `amount`       in the order currency, as WooCommerce formatted it;
 * - `reason`, `line_items`, `restock`, `restocked`, `payment_id`, `mode`, `requested_at`;
 * - `wc_refund_id` the WooCommerce refund recorded on `refund.sent`.
 * The recorded WooCommerce refund carries `_tendr_refund_id`, `_tendr_refund_ref` and
 * `_tendr_refund_state` = 'sent'.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Store refunds.
 */
final class Tendr_Refunds {

	const META              = '_tendr_refunds';
	const SEQ_META          = '_tendr_refund_seq';
	const UNTRACKED_META    = '_tendr_untracked_refunds';
	const REFUND_META_ID    = '_tendr_refund_id';
	const REFUND_META_REF   = '_tendr_refund_ref';
	const REFUND_META_STATE = '_tendr_refund_state';

	/** States whose amount may still leave (counted against what can be refunded). */
	const OPEN_STATES = array( 'pending', 'review', 'unconfirmed' );

	/**
	 * Seconds after which a request tendr's re-read does not list is taken as gone (C5): long
	 * enough that it is never a request still being made.
	 */
	const LAPSE_AFTER = 5 * MINUTE_IN_SECONDS;

	/** Nonce action for dismissing an unconfirmed request. */
	const DISMISS_NONCE = 'tendr_dismiss_refund';

	/** API errors that may hide a refund tendr did create (its answer was lost). */
	const AMBIGUOUS_CODES = array( 'tendr_unreachable', 'tendr_bad_response', 'IDEMPOTENCY_IN_PROGRESS' );

	/**
	 * The request being recorded on refund.sent (its refund must not be intercepted).
	 *
	 * @var array{ext: string, refund_id: string}|null
	 */
	private static ?array $recording = null;

	/**
	 * Hooks.
	 */
	public static function register(): void {
		add_action( 'woocommerce_create_refund', array( self::class, 'before_save' ), 10, 2 );
		add_action( 'woocommerce_admin_order_data_after_order_details', array( self::class, 'render_pending' ) );
		add_action( 'admin_post_tendr_dismiss_refund', array( self::class, 'handle_dismiss_request' ) );
	}

	// ------------------------------------------------------------------ requesting.

	/**
	 * `woocommerce_create_refund` (before the refund is saved), for tendr orders:
	 * - the plugin's own refund.sent record: tag it, let it through;
	 * - "refund via tendr": ask tendr, then throw so WooCommerce saves nothing;
	 * - a manual refund: refuse it when it would leave less than the refunds waiting in tendr.
	 *
	 * @param WC_Order_Refund $refund Refund, not yet saved.
	 * @param array           $args   wc_create_refund() arguments.
	 * @throws Exception To stop WooCommerce saving the refund (its message is shown to the admin).
	 */
	public static function before_save( $refund, $args ): void {
		if ( ! $refund instanceof WC_Order_Refund || ! is_array( $args ) ) {
			return;
		}
		$order = wc_get_order( $refund->get_parent_id() );
		if ( ! $order instanceof WC_Order || Tendr_Gateway::ID !== $order->get_payment_method() ) {
			return;
		}
		if ( null !== self::$recording ) {
			$refund->update_meta_data( self::REFUND_META_ID, self::$recording['refund_id'] );
			$refund->update_meta_data( self::REFUND_META_REF, self::$recording['ext'] );
			$refund->update_meta_data( self::REFUND_META_STATE, 'sent' );
			return;
		}
		if ( empty( $args['refund_payment'] ) ) {
			try {
				self::guard_manual( $order, (float) ( $args['amount'] ?? 0 ), $refund->get_id() );
			} catch ( Exception $e ) {
				self::drop_draft_items( $refund );
				throw $e;
			}
			return;
		}
		$result = self::request( $order->get_id(), $args, $refund->get_id() );
		self::drop_draft_items( $refund );
		throw new Exception( is_wp_error( $result ) ? $result->get_error_message() : $result ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text: WooCommerce shows it in an alert / REST error.
	}

	/**
	 * Delete the item rows WooCommerce already stored for its draft refund (it saved them while
	 * totalling): WooCommerce deletes the draft itself when the hook throws, but on HPOS not its
	 * items, which would stay behind as orphan `woocommerce_order_items` rows.
	 *
	 * @param WC_Order_Refund $refund The draft.
	 */
	private static function drop_draft_items( WC_Order_Refund $refund ): void {
		if ( $refund->get_id() <= 0 ) {
			return;
		}
		// Deleted one by one: remove_order_items() only forgets them until the next save.
		foreach ( $refund->get_items( array( 'line_item', 'fee', 'shipping', 'tax', 'coupon' ) ) as $item_id => $item ) {
			if ( $item_id > 0 ) {
				wc_delete_order_item( (int) $item_id );
			}
		}
	}

	/**
	 * Refuse a manual refund that would leave less to refund than what waits in tendr.
	 *
	 * @param WC_Order $order  Order.
	 * @param float    $amount Manual refund amount.
	 * @param int      $draft  The refund being created (WooCommerce has already stored it as a draft).
	 * @throws Exception When it would.
	 */
	private static function guard_manual( WC_Order $order, float $amount, int $draft ): void {
		$open = (float) self::pending_total( $order );
		if ( $open <= 0 ) {
			return;
		}
		$remaining = self::remaining( $order, $draft );
		if ( round( $amount + $open - $remaining, wc_get_price_decimals() ) > 0 ) {
			throw new Exception(
				esc_html(
					sprintf(
						/* translators: 1: amount awaiting approval, 2: most that can be refunded manually. */
						__( 'Refunds of %1$s for this order are awaiting approval in tendr, so a manual refund can be at most %2$s now.', 'tendr' ),
						self::money( $order, (string) $open ),
						self::money( $order, (string) max( 0, $remaining - $open ) )
					)
				)
			);
		}
	}

	/**
	 * Ask tendr for a refund. Called before WooCommerce saves anything.
	 *
	 * @param int   $order_id Order id.
	 * @param array $args     wc_create_refund() arguments (amount, reason, line_items, restock_items).
	 * @param int   $draft    The refund WooCommerce is creating (stored as a draft until it fails).
	 * @return string|WP_Error The message for the admin once tendr has the request, or why not.
	 */
	public static function request( int $order_id, array $args, int $draft = 0 ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return new WP_Error( 'tendr_refund_forbidden', __( 'You are not allowed to refund orders.', 'tendr' ) );
		}
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || '' === self::payment_id( $order ) ) {
			return new WP_Error( 'tendr_refund_unavailable', __( 'This order was not paid through tendr, so tendr cannot refund it.', 'tendr' ) );
		}
		$formatted = wc_format_decimal( (string) ( $args['amount'] ?? '' ), wc_get_price_decimals() );
		$plain     = self::plain( (string) $formatted );
		if ( '0' === $plain || ! preg_match( '/^\d+(\.\d+)?$/', $plain ) ) {
			return new WP_Error( 'tendr_refund_amount', __( 'Enter an amount to refund.', 'tendr' ) );
		}

		if ( ! Tendr_Order_Sync::lock_order( $order_id ) ) {
			return new WP_Error( 'tendr_refund_busy', __( 'This order is being updated by tendr right now. Try the refund again in a moment.', 'tendr' ) );
		}
		try {
			$order = wc_get_order( $order_id );
			if ( ! $order instanceof WC_Order ) {
				return new WP_Error( 'tendr_refund_unavailable', __( 'This order no longer exists.', 'tendr' ) );
			}
			$requests = self::requests( $order );

			// WooCommerce does not count the refunds waiting in tendr: together with this one they
			// may not exceed what is left.
			$open      = (float) self::pending_total( $order );
			$remaining = self::remaining( $order, $draft );
			if ( round( $open + (float) $formatted - $remaining, wc_get_price_decimals() ) > 0 ) {
				return new WP_Error(
					'tendr_refund_exceeds_pending',
					sprintf(
						/* translators: 1: amount awaiting approval, 2: amount that can still be refunded. */
						__( 'Refunds of %1$s for this order are already awaiting approval in tendr, so at most %2$s more can be refunded now.', 'tendr' ),
						self::money( $order, (string) $open ),
						self::money( $order, (string) max( 0, $remaining - $open ) )
					)
				);
			}

			$seq = absint( $order->get_meta( self::SEQ_META ) ) + 1;
			$order->update_meta_data( self::SEQ_META, (string) $seq );
			$order->save_meta_data();

			$mode         = self::order_mode( $order );
			$external_ref = 'wc_refund_' . $order_id . '_' . $seq;
			$reason       = trim( wp_strip_all_tags( (string) ( $args['reason'] ?? '' ) ) );
			$body         = array(
				'payment'  => self::payment_id( $order ),
				'amount'   => $plain,
				'currency' => $order->get_currency(),
			);
			if ( '' !== $reason ) {
				$body['reason'] = mb_substr( $reason, 0, 500 );
			}
			$body['external_ref'] = $external_ref;

			$record = array(
				'refund_id'    => '',
				'state'        => 'unconfirmed',
				'amount'       => (string) $formatted,
				'reason'       => $reason,
				'line_items'   => isset( $args['line_items'] ) && is_array( $args['line_items'] ) ? $args['line_items'] : array(),
				'restock'      => ! empty( $args['restock_items'] ),
				'restocked'    => false,
				'payment_id'   => $body['payment'],
				'mode'         => $mode,
				'requested_at' => time(),
				'wc_refund_id' => 0,
			);
			$prefix = 'test' === $mode ? __( '[Test]', 'tendr' ) . ' ' : '';
			$money  = self::money( $order, (string) $formatted );

			$result   = Tendr_Api_Client::request( 'POST', '/v1/refunds', $body, $mode, array( 'Idempotency-Key' => $external_ref ) );
			$tendr_id = ! is_wp_error( $result ) && isset( $result['id'] ) && is_string( $result['id'] ) && preg_match( '/^ref_[A-Za-z0-9]{1,64}$/', $result['id'] ) ? $result['id'] : '';
			if ( is_wp_error( $result ) && ! self::is_ambiguous( $result ) ) {
				return new WP_Error( 'tendr_refund_refused', self::refusal_message( $result ) );
			}
			if ( '' === $tendr_id ) {
				// tendr may have the request: keep it, so its events are matched when they come.
				$requests[ $external_ref ] = $record;
				self::save_requests( $order, $requests );
				$order->add_order_note(
					$prefix . esc_html(
						sprintf(
							/* translators: 1: amount, 2: refund reference. */
							__( 'tendr could not confirm the refund request of %1$s (%2$s). Check the tendr dashboard before refunding again: if tendr received it, this order is updated when the refund is sent.', 'tendr' ),
							$money,
							$external_ref
						)
					)
				);
				return new WP_Error(
					'tendr_refund_unconfirmed',
					__( 'tendr did not confirm the refund request, so nothing is recorded here yet. Check the tendr dashboard before refunding again.', 'tendr' )
				);
			}

			$review                    = 'review' === ( $result['status'] ?? null );
			$record['refund_id']       = $tendr_id;
			$record['state']           = $review ? 'review' : 'pending';
			$requests[ $external_ref ] = $record;
			self::save_requests( $order, $requests );

			if ( $review ) {
				$why  = self::review_reason_text( isset( $result['review_reason'] ) && is_string( $result['review_reason'] ) ? $result['review_reason'] : '' );
				$note = esc_html(
					sprintf(
						/* translators: 1: amount, 2: why it waits (a sentence). */
						__( 'Refund of %1$s is waiting for manual review in tendr before it can be approved. %2$s Nothing has been refunded yet.', 'tendr' ),
						$money,
						$why
					)
				) . ' ' . Tendr_Order_Sync::review_link( $mode );
			} else {
				$url  = Tendr_Plugin::dashboard_url( '/dashboard/approvals', $mode );
				$note = esc_html(
					sprintf(
						/* translators: %s: amount. */
						__( 'Refund of %s awaiting approval in tendr. Nothing is refunded until your store\'s signers approve it.', 'tendr' ),
						$money
					)
				) . ' ' . esc_html__( 'Approve it:', 'tendr' ) . ' <a href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $url ) . '</a>';
			}
			$order->add_order_note( $prefix . $note );

			return $review
				/* translators: %s: amount. */
				? sprintf( __( 'Refund of %s sent to tendr. It needs a manual review in tendr before your signers can approve it. WooCommerce will record it once it is sent.', 'tendr' ), $money )
				/* translators: %s: amount. */
				: sprintf( __( 'Refund of %s sent to your Tendr signers for approval. WooCommerce will record it once it is sent.', 'tendr' ), $money );
		} finally {
			Tendr_Order_Sync::unlock_order( $order_id );
		}//end try
	}

	/**
	 * Why a refund waits for a person, from tendr's `review_reason` (C6).
	 *
	 * @param string $reason Review reason ('' when tendr gave none).
	 */
	private static function review_reason_text( string $reason ): string {
		switch ( $reason ) {
			case 'needs_swap_route':
				return __( 'The shopper paid from another chain than your settlement asset\'s: someone on your team must choose the swap route in tendr.', 'tendr' );
			case 'no_sender':
				return __( 'tendr does not know the wallet that paid: someone on your team must enter where to send the refund in tendr.', 'tendr' );
			case 'unsupported_chain':
				return __( 'tendr cannot send to the chain the shopper paid from: someone on your team must choose another destination in tendr.', 'tendr' );
			case 'sanctions':
				return __( 'The wallet that paid failed sanctions screening: someone on your team must review it in tendr (a legal acknowledgement is required).', 'tendr' );
			case 'price_unavailable':
				return __( 'tendr could not price the refund in your settlement asset: someone on your team must retry it in tendr.', 'tendr' );
			default:
				return __( 'Refunds are paid in your settlement asset: when the shopper paid from another chain or from an exchange, someone on your team must choose the route or the address in tendr first.', 'tendr' );
		}
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
		$ext      = isset( $data['refund_external_ref'] ) && is_string( $data['refund_external_ref'] ) ? $data['refund_external_ref'] : '';
		$tendr_id = isset( $data['refund_id'] ) && is_string( $data['refund_id'] ) ? $data['refund_id'] : '';
		$pay_id   = isset( $data['payment_id'] ) && is_string( $data['payment_id'] ) ? $data['payment_id'] : '';
		$requests = self::requests( $order );
		$req      = $requests[ $ext ] ?? null;
		$ours     = 1 === preg_match( '/^wc_refund_([1-9][0-9]{0,19})_([1-9][0-9]{0,9})$/', $ext, $m ) && (int) $m[1] === $order->get_id();

		if ( '' === $tendr_id ) {
			return 'noop';
		}
		$row = self::refund_in_view( $view, $pay_id, $tendr_id );
		if ( null === $row ) {
			return 'noop';
		}
		if ( ! $ours || null === $req ) {
			// Not requested from this order screen (e.g. started on the tendr dashboard).
			return 'refund.sent' === $type ? self::note_untracked_sent( $order, $event, $row, $tendr_id, $pay_id ) : 'noop';
		}
		if ( $pay_id !== $req['payment_id'] || ( '' !== $req['refund_id'] && $req['refund_id'] !== $tendr_id ) ) {
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
					return self::finish( $order, $requests, $ext, $req, $adopted );
				}
				if ( ! $sent ) {
					return self::finish( $order, $requests, $ext, $req, $adopted );
				}
				return self::record_sent( $order, $event, $requests, $ext, $req, $row );

			case 'refund.cancelled':
			case 'refund.failed':
				if ( 'sent' === $req['state'] || $sent || in_array( $req['state'], array( 'cancelled', 'failed' ), true ) ) {
					return self::finish( $order, $requests, $ext, $req, $adopted );
				}
				$req['state'] = 'refund.cancelled' === $type ? 'cancelled' : 'failed';
				$money        = self::money( $order, $req['amount'] );
				$text         = 'cancelled' === $req['state']
					/* translators: %s: amount. */
					? sprintf( __( 'The refund of %s was not approved in tendr (it was rejected or expired). Nothing was refunded and the order totals are unchanged.', 'tendr' ), $money )
					/* translators: %s: amount. */
					: sprintf( __( 'The refund of %s could not be sent by tendr. Nothing was refunded and the order totals are unchanged; refund again to retry.', 'tendr' ), $money );
				$requests[ $ext ] = $req;
				self::save_requests( $order, $requests );
				Tendr_Order_Sync::note( $order, $event, esc_html( $text ) );
				return 'applied';

			case 'refund.pending':
				if ( 'review' !== $req['state'] ) {
					return self::finish( $order, $requests, $ext, $req, $adopted );
				}
				$req['state']     = 'pending';
				$requests[ $ext ] = $req;
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
					return self::finish( $order, $requests, $ext, $req, $adopted );
				}
				$req['state']     = 'review';
				$requests[ $ext ] = $req;
				self::save_requests( $order, $requests );
				Tendr_Order_Sync::note(
					$order,
					$event,
					/* translators: %s: amount. */
					esc_html( sprintf( __( 'The refund of %s is waiting for the shopper: they paid from an exchange, and tendr has asked them by email where to receive it.', 'tendr' ), self::money( $order, $req['amount'] ) ) )
				);
				return 'applied';

			default:
				return self::finish( $order, $requests, $ext, $req, $adopted );
		}//end switch
	}

	/**
	 * Save an adopted request (if any) and report a no-op.
	 *
	 * @param WC_Order $order    Order.
	 * @param array    $requests All requests.
	 * @param string   $ext      This request's external_ref.
	 * @param array    $req      This request.
	 * @param bool     $adopted  Whether it was just adopted.
	 */
	private static function finish( WC_Order $order, array $requests, string $ext, array $req, bool $adopted ): string {
		if ( $adopted ) {
			$requests[ $ext ] = $req;
			self::save_requests( $order, $requests );
		}
		return 'noop';
	}

	/**
	 * Record the WooCommerce refund for a sent tendr refund, exactly once: a retry or replay finds
	 * the refund already recorded (tagged with its external_ref) and never restocks twice.
	 *
	 * @param WC_Order $order    Order.
	 * @param array    $event    Event.
	 * @param array    $requests All requests.
	 * @param string   $ext      This request's external_ref.
	 * @param array    $req      This request.
	 * @param array    $row      The refund in the session view.
	 * @return string|WP_Error
	 */
	private static function record_sent( WC_Order $order, array $event, array $requests, string $ext, array $req, array $row ) {
		$money  = self::money( $order, $req['amount'] );
		$refund = self::recorded_refund( $order, $ext );

		if ( null === $refund ) {
			if ( round( (float) $req['amount'] - self::remaining( $order ), wc_get_price_decimals() ) > 0 ) {
				// The money left, but WooCommerce has less left to refund (e.g. a manual refund meanwhile).
				$req['state']     = 'sent';
				$requests[ $ext ] = $req;
				self::save_requests( $order, $requests );
				Tendr_Order_Sync::note(
					$order,
					$event,
					/* translators: %s: amount. */
					esc_html( sprintf( __( 'tendr sent the refund of %s, but WooCommerce could not record it because the order has less left to refund. Record it by hand so the totals match.', 'tendr' ), $money ) )
				);
				return 'applied';
			}
			self::$recording = array(
				'ext'       => $ext,
				'refund_id' => (string) $req['refund_id'],
			);
			try {
				// Restock is done below, once, not by WooCommerce: a failure after its restock would
				// restock again on the retry.
				$refund = wc_create_refund(
					array(
						'order_id'       => $order->get_id(),
						'amount'         => $req['amount'],
						'reason'         => '' !== $req['reason'] ? $req['reason'] : null,
						'line_items'     => $req['line_items'],
						'refund_payment' => false,
						'restock_items'  => false,
					)
				);
			} finally {
				self::$recording = null;
			}
			if ( is_wp_error( $refund ) ) {
				// WooCommerce deleted its row; drop totals it may have cached while the row existed.
				WC_Cache_Helper::invalidate_cache_group( 'orders' );
				return new WP_Error( 'tendr_refund_record_failed', $refund->get_error_message() );
			}
		}//end if

		$order               = wc_get_order( $order->get_id() );
		$requests            = self::requests( $order );
		$req['state']        = 'sent';
		$req['wc_refund_id'] = $refund->get_id();
		$restock             = ! empty( $req['restock'] ) && empty( $req['restocked'] ) && array() !== $req['line_items'];
		if ( $restock ) {
			// Marked before restocking: a crash in between misses a restock rather than doing two.
			$req['restocked'] = true;
		}
		$requests[ $ext ] = $req;
		self::save_requests( $order, $requests );
		if ( $restock ) {
			wc_restock_refunded_items( $order, $req['line_items'] );
		}

		$tokens = self::token_amount( $row );
		$text   = '' !== $tokens && ! str_contains( $tokens, '(' )
			/* translators: 1: amount in the order currency, 2: token amount, e.g. "10.05 USDC". */
			? esc_html( sprintf( __( 'Refund of %1$s sent by tendr (%2$s, network cost included).', 'tendr' ), $money, $tokens ) )
			/* translators: %s: amount. */
			: esc_html( sprintf( __( 'Refund of %s sent by tendr.', 'tendr' ), $money ) );
		$text .= self::transaction_text( $row, $event );
		/* translators: %s: tendr refund id. */
		$text .= ' ' . esc_html( sprintf( __( 'tendr refund %s.', 'tendr' ), $req['refund_id'] ) );
		Tendr_Order_Sync::note( $order, $event, $text );
		return 'applied';
	}

	/**
	 * A refund tendr sent for this order's payment that was not requested from WooCommerce (e.g.
	 * from the tendr dashboard): a note asking the merchant to record it. No WooCommerce refund is
	 * created, since its amount in the store currency is not known.
	 *
	 * @param WC_Order $order     Order.
	 * @param array    $event     Event.
	 * @param array    $row       The refund in the session view.
	 * @param string   $tendr_id  tendr refund id.
	 * @param string   $payment   Payment id.
	 * @return string
	 */
	private static function note_untracked_sent( WC_Order $order, array $event, array $row, string $tendr_id, string $payment ): string {
		if (
			'confirmed' !== ( $row['status'] ?? null )
			|| 'merchant' !== ( $row['reason'] ?? null )
			|| '' === self::payment_id( $order )
			|| self::payment_id( $order ) !== $payment
		) {
			return 'noop';
		}
		$noted = $order->get_meta( self::UNTRACKED_META );
		$noted = is_array( $noted ) ? $noted : array();
		if ( in_array( $tendr_id, $noted, true ) ) {
			return 'noop';
		}
		$noted[] = $tendr_id;
		$order->update_meta_data( self::UNTRACKED_META, array_slice( $noted, -50 ) );
		$order->save_meta_data();

		$text   = esc_html__( 'tendr sent a refund for this order that was not requested from WooCommerce (for example, from the tendr dashboard).', 'tendr' );
		$tokens = self::token_amount( $row );
		if ( '' !== $tokens ) {
			/* translators: %s: token amount, e.g. "1.25 USDC". */
			$text .= ' ' . esc_html( sprintf( __( 'Amount: %s.', 'tendr' ), $tokens ) );
		}
		$text .= self::transaction_text( $row, $event );
		/* translators: %s: tendr refund id. */
		$text .= ' ' . esc_html( sprintf( __( 'tendr refund %s.', 'tendr' ), $tendr_id ) );
		$text .= ' ' . esc_html__( 'WooCommerce has not recorded it: add the refund to this order by hand (Refund, then "Refund manually") so the totals match.', 'tendr' );
		Tendr_Order_Sync::note( $order, $event, $text );
		return 'applied';
	}

	/**
	 * A refund row's amount as "1.25 USDC" when tendr names the asset's symbol and decimals (C6),
	 * else "<base units> (token base units) of <asset id>", or ''.
	 *
	 * @param array $row The refund in the session view.
	 */
	private static function token_amount( array $row ): string {
		$amount = isset( $row['amount'] ) && is_scalar( $row['amount'] ) ? (string) $row['amount'] : '';
		if ( ! preg_match( '/^\d+$/', $amount ) ) {
			return '';
		}
		$symbol   = isset( $row['asset_symbol'] ) && is_string( $row['asset_symbol'] ) && preg_match( '/^[A-Za-z0-9.$_-]{1,16}$/', $row['asset_symbol'] ) ? $row['asset_symbol'] : '';
		$decimals = isset( $row['asset_decimals'] ) && is_int( $row['asset_decimals'] ) && $row['asset_decimals'] >= 0 && $row['asset_decimals'] <= 36 ? $row['asset_decimals'] : null;
		if ( '' !== $symbol && null !== $decimals ) {
			$padded = str_pad( $amount, $decimals + 1, '0', STR_PAD_LEFT );
			$whole  = 0 === $decimals ? $padded : substr( $padded, 0, -$decimals );
			$frac   = 0 === $decimals ? '' : rtrim( substr( $padded, -$decimals ), '0' );
			return $whole . ( '' !== $frac ? '.' . $frac : '' ) . ' ' . $symbol;
		}
		$asset = isset( $row['asset_id'] ) && is_string( $row['asset_id'] ) ? $row['asset_id'] : '';
		/* translators: 1: amount in token base units, 2: token (asset id). */
		return sprintf( __( '%1$s (token base units) of %2$s', 'tendr' ), $amount, $asset );
	}

	/**
	 * " Transaction: <explorer link>." for a sent refund, or ''.
	 *
	 * @param array $row   The refund in the session view.
	 * @param array $event Event.
	 */
	private static function transaction_text( array $row, array $event ): string {
		$chain = isset( $row['destination_chain'] ) && is_string( $row['destination_chain'] ) ? $row['destination_chain'] : '';
		$hash  = isset( $row['refund_tx_hash'] ) && is_string( $row['refund_tx_hash'] ) ? $row['refund_tx_hash'] : '';
		if ( '' === $hash ) {
			return '';
		}
		$url = Tendr_Order_Sync::explorer_url( $chain, $hash, ! empty( $event['livemode'] ) );
		return ' ' . esc_html__( 'Transaction:', 'tendr' ) . ' ' . ( null !== $url
			? '<a href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $url ) . '</a>'
			: esc_html( $hash ) );
	}

	/**
	 * The WooCommerce refund already recorded for an external_ref, or null.
	 *
	 * @param WC_Order $order Order.
	 * @param string   $ext   external_ref.
	 */
	private static function recorded_refund( WC_Order $order, string $ext ): ?WC_Order_Refund {
		foreach ( $order->get_refunds() as $refund ) {
			if ( $refund instanceof WC_Order_Refund && $refund->get_meta( self::REFUND_META_REF ) === $ext ) {
				return $refund;
			}
		}
		return null;
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

	// ------------------------------------------------------------------ reconciling.

	/**
	 * C5: after any verified event of the order (whatever its type), compare the order's open
	 * requests with the fresh session view, so a request stops reserving its amount once tendr
	 * says it will never be sent. Only requests of a payment the view lists are judged:
	 * - tendr lists it (by refund id, or by its external_ref for one never confirmed): adopt the
	 *   id; `cancelled` there → cancelled here (note);
	 * - tendr does not list it, LAPSE_AFTER after it was asked: lapsed (note).
	 * A sent refund is left to `refund.sent`, which records it. Called under the order lock.
	 *
	 * @param WC_Order|false $order Order.
	 * @param array          $event Verified event.
	 * @param array          $view  The session as re-read from the API.
	 */
	public static function reconcile( $order, array $event, array $view ): void {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$requests = self::requests( $order );
		$changed  = false;
		foreach ( $requests as $ext => $req ) {
			if ( ! in_array( $req['state'], self::OPEN_STATES, true ) ) {
				continue;
			}
			$refunds = self::refunds_of_payment( $view, (string) $req['payment_id'] );
			if ( null === $refunds ) {
				// Another session's payment: this view cannot tell.
				continue;
			}
			$row = null;
			foreach ( $refunds as $candidate ) {
				$by_id  = '' !== $req['refund_id'] && ( $candidate['id'] ?? null ) === $req['refund_id'];
				$by_ref = '' === $req['refund_id'] && ( $candidate['refund_external_ref'] ?? null ) === $ext;
				if ( $by_id || $by_ref ) {
					$row = $candidate;
					break;
				}
			}
			$money = self::money( $order, $req['amount'] );
			if ( null === $row ) {
				if ( time() - (int) $req['requested_at'] < self::LAPSE_AFTER ) {
					continue;
				}
				$req['state'] = 'lapsed';
				Tendr_Order_Sync::note(
					$order,
					$event,
					esc_html(
						sprintf(
							/* translators: 1: amount, 2: refund reference. */
							__( 'tendr has no record of the refund request of %1$s (%2$s): nothing was refunded, and it no longer counts against what can be refunded.', 'tendr' ),
							$money,
							$ext
						)
					)
				);
			} else {
				if ( '' === $req['refund_id'] && is_string( $row['id'] ?? null ) ) {
					$req['refund_id'] = $row['id'];
					$req['state']     = 'pending';
				}
				$status = $row['merchant_status'] ?? null;
				if ( 'cancelled' === $status ) {
					$req['state'] = 'cancelled';
					Tendr_Order_Sync::note(
						$order,
						$event,
						/* translators: %s: amount. */
						esc_html( sprintf( __( 'The refund of %s was closed in tendr without being sent: nothing was refunded, and it no longer counts against what can be refunded.', 'tendr' ), $money ) )
					);
				} elseif ( 'review' === $status && 'pending' === $req['state'] ) {
					$req['state'] = 'review';
				}
			}//end if
			$requests[ $ext ] = $req;
			$changed          = true;
		}//end foreach
		if ( $changed ) {
			self::save_requests( $order, $requests );
		}
	}

	/**
	 * The refund rows of payment `$payment_id` in a session view, or null when the view does not
	 * list that payment.
	 *
	 * @param array  $view       Session view.
	 * @param string $payment_id Payment id.
	 * @return array<int, array>|null
	 */
	private static function refunds_of_payment( array $view, string $payment_id ): ?array {
		foreach ( ( isset( $view['payments'] ) && is_array( $view['payments'] ) ) ? $view['payments'] : array() as $payment ) {
			if ( is_array( $payment ) && '' !== $payment_id && ( $payment['id'] ?? null ) === $payment_id ) {
				$rows = isset( $payment['refunds'] ) && is_array( $payment['refunds'] ) ? $payment['refunds'] : array();
				return array_values( array_filter( $rows, 'is_array' ) );
			}
		}
		return null;
	}

	/**
	 * C5: a store manager dismisses a request tendr never confirmed (its answer was lost and
	 * nothing has said since whether tendr has it): it stops counting against what can be
	 * refunded. If tendr did have it after all, its `refund.sent` still records it.
	 *
	 * @param int    $order_id Order id.
	 * @param string $ext      The request's external_ref.
	 * @return true|WP_Error
	 */
	public static function dismiss( int $order_id, string $ext ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return new WP_Error( 'tendr_refund_forbidden', __( 'You are not allowed to change refunds.', 'tendr' ) );
		}
		if ( ! Tendr_Order_Sync::lock_order( $order_id ) ) {
			return new WP_Error( 'tendr_refund_busy', __( 'This order is being updated by tendr right now. Try again in a moment.', 'tendr' ) );
		}
		try {
			$order    = wc_get_order( $order_id );
			$requests = $order instanceof WC_Order ? self::requests( $order ) : array();
			$req      = $requests[ $ext ] ?? null;
			if ( ! $order instanceof WC_Order || null === $req || 'unconfirmed' !== $req['state'] ) {
				return new WP_Error( 'tendr_refund_not_dismissable', __( 'Only a refund request tendr never confirmed can be dismissed.', 'tendr' ) );
			}
			$req['state']     = 'dismissed';
			$requests[ $ext ] = $req;
			self::save_requests( $order, $requests );
			$user = wp_get_current_user();
			$order->add_order_note(
				esc_html(
					sprintf(
						/* translators: 1: amount, 2: refund reference, 3: user name. */
						__( 'The unconfirmed refund request of %1$s (%2$s) was dismissed by %3$s: it no longer counts against what can be refunded. If tendr sends it after all, this order is still updated.', 'tendr' ),
						self::money( $order, $req['amount'] ),
						$ext,
						$user->display_name
					)
				)
			);
			return true;
		} finally {
			Tendr_Order_Sync::unlock_order( $order_id );
		}//end try
	}

	/**
	 * `admin-post.php?action=tendr_dismiss_refund` (POST from the order screen, nonce, capability).
	 */
	public static function handle_dismiss_request(): void {
		$nonce    = isset( $_POST['tendr_dismiss_refund_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_dismiss_refund_nonce'] ) ) : '';
		$order_id = isset( $_POST['tendr_dismiss_order'] ) ? absint( $_POST['tendr_dismiss_order'] ) : 0;
		$ext      = isset( $_POST['tendr_dismiss_refund'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_dismiss_refund'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, self::DISMISS_NONCE . '_' . $order_id ) || ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr' ), 403 );
		}
		$result = self::dismiss( $order_id, $ext );
		if ( is_wp_error( $result ) ) {
			wp_die( esc_html( $result->get_error_message() ), 409 );
		}
		$order = wc_get_order( $order_id );
		wp_safe_redirect( $order instanceof WC_Order ? $order->get_edit_order_url() : admin_url() );
		exit;
	}

	// ------------------------------------------------------------------ state.

	/**
	 * The order's tendr refund requests, by external_ref.
	 *
	 * @param WC_Order $order Order.
	 * @return array<string, array>
	 */
	public static function requests( WC_Order $order ): array {
		$raw = $order->get_meta( self::META );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $ext => $req ) {
			if ( is_array( $req ) && is_string( $ext ) && str_starts_with( $ext, 'wc_refund_' ) ) {
				$out[ $ext ] = array_merge(
					array(
						'refund_id'    => '',
						'state'        => 'unconfirmed',
						'amount'       => '0',
						'reason'       => '',
						'line_items'   => array(),
						'restock'      => false,
						'restocked'    => false,
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
	 * @param array    $requests By external_ref.
	 */
	private static function save_requests( WC_Order $order, array $requests ): void {
		$order->update_meta_data( self::META, $requests );
		$order->save_meta_data();
	}

	/**
	 * What may still leave through tendr (pending, in review, or unconfirmed), in the order
	 * currency, e.g. "25" or "0".
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
		return self::plain( (string) wc_format_decimal( $sum, wc_get_price_decimals() ) );
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
		$lines   = array();
		$dismiss = array();
		foreach ( self::requests( $order ) as $ext => $req ) {
			$money = self::money( $order, $req['amount'] );
			switch ( $req['state'] ) {
				case 'pending':
					/* translators: %s: amount. */
					$lines[] = sprintf( __( '%s: awaiting approval in tendr', 'tendr' ), $money );
					break;
				case 'review':
					/* translators: %s: amount. */
					$lines[] = sprintf( __( '%s: waiting for review in tendr', 'tendr' ), $money );
					break;
				case 'unconfirmed':
					/* translators: %s: amount. */
					$lines[]                        = sprintf( __( '%s: not confirmed by tendr; check the tendr dashboard', 'tendr' ), $money );
					$dismiss[ count( $lines ) - 1 ] = $ext;
					break;
			}
		}
		if ( array() === $lines ) {
			return;
		}
		echo '<div class="notice notice-info inline tendr-pending-refunds" style="clear:both;margin:12px 0 0;"><p><strong>'
			. esc_html__( 'Refunds not yet sent (not counted in the totals):', 'tendr' ) . '</strong></p><ul>';
		$action = add_query_arg( 'action', 'tendr_dismiss_refund', admin_url( 'admin-post.php' ) );
		$nonce  = false;
		foreach ( $lines as $i => $line ) {
			echo '<li>' . esc_html( $line );
			if ( isset( $dismiss[ $i ] ) && current_user_can( 'manage_woocommerce' ) ) {
				if ( ! $nonce ) {
					// The box sits inside the order form: the button posts it to its own action.
					wp_nonce_field( self::DISMISS_NONCE . '_' . $order->get_id(), 'tendr_dismiss_refund_nonce' );
					echo '<input type="hidden" name="tendr_dismiss_order" value="' . esc_attr( (string) $order->get_id() ) . '">';
					$nonce = true;
				}
				echo ' <button type="submit" class="button button-small" formmethod="post" formaction="' . esc_url( $action ) . '" name="tendr_dismiss_refund" value="' . esc_attr( $dismiss[ $i ] ) . '">'
					. esc_html__( 'Dismiss', 'tendr' ) . '</button>';
			}
			echo '</li>';
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
	 * What WooCommerce can still refund, read from the store (not the order's cache), leaving out
	 * the refund being created: wc_create_refund() stores it as a draft before its hooks run, and
	 * deletes it when the hook stops it.
	 *
	 * @param WC_Order $order Order.
	 * @param int      $draft Refund id to leave out (0 for none).
	 */
	private static function remaining( WC_Order $order, int $draft = 0 ): float {
		$refunds  = wc_get_orders(
			array(
				'type'    => 'shop_order_refund',
				'parent'  => $order->get_id(),
				'limit'   => -1,
				'exclude' => $draft > 0 ? array( $draft ) : array(),
			)
		);
		$refunded = 0.0;
		foreach ( $refunds as $refund ) {
			if ( $refund instanceof WC_Order_Refund ) {
				$refunded += (float) $refund->get_amount();
			}
		}
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
