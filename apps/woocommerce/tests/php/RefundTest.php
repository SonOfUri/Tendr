<?php
/**
 * Refunds from WooCommerce admin (spec §7): a refund becomes a signer-approved proposal in tendr,
 * and the WooCommerce refund is recorded only once tendr reports the money sent.
 *
 * @package Tendr
 */

/**
 * Tendr_Refunds, Tendr_Gateway::process_refund and the refund.* webhook events.
 */
class RefundTest extends Tendr_Test_Case {

	const SESSION_ID = 'ses_01JREFUNDSESSION0000000000';
	const PAYMENT_ID = 'pay_01JREFUNDPAYMENT0000000000';

	/**
	 * Credentials stored by connect_locally().
	 *
	 * @var array
	 */
	private array $issued = array();

	/**
	 * Sessions the mocked API knows: id => GET view.
	 *
	 * @var array<string, array>
	 */
	private array $sessions = array();

	/**
	 * When set, every session GET answers this: [status, json|null].
	 *
	 * @var array|null
	 */
	private ?array $get_reply = null;

	/**
	 * Replies queued for `POST /v1/refunds`: [status, json]. Default: 201 pending.
	 *
	 * @var array<int, array>
	 */
	private array $refund_replies = array();

	/**
	 * Bodies posted to `/v1/refunds`.
	 *
	 * @var array<int, array>
	 */
	private array $refund_posts = array();

	/**
	 * Tendr refund ids handed out.
	 *
	 * @var int
	 */
	private int $refund_seq = 0;

	/**
	 * Unique event ids.
	 *
	 * @var int
	 */
	private static int $seq = 0;

	public function set_up(): void {
		parent::set_up();
		$this->issued         = self::connect_locally();
		$this->sessions       = array();
		$this->get_reply      = null;
		$this->refund_replies = array();
		$this->refund_posts   = array();
		$this->refund_seq     = 0;
		update_option( 'woocommerce_manage_stock', 'yes' );
		$this->mock_http( fn( $url, $args ) => $this->api( $url, $args ) );
		reset_phpmailer_instance();
		$this->login_admin();
	}

	/**
	 * The mocked API: session GETs and refund POSTs.
	 *
	 * @param string $url  URL.
	 * @param array  $args Request args.
	 */
	private function api( string $url, array $args ): array {
		$path = (string) wp_parse_url( $url, PHP_URL_PATH );
		if ( 'GET' === $args['method'] && preg_match( '#^/v1/checkout/sessions/([A-Za-z0-9_]+)$#', $path, $m ) ) {
			if ( null !== $this->get_reply ) {
				return self::response( $this->get_reply[0], $this->get_reply[1] );
			}
			return isset( $this->sessions[ $m[1] ] )
				? self::response( 200, $this->sessions[ $m[1] ] )
				: self::response( 404, self::api_error( 'NOT_FOUND', 'Session not found' ) );
		}
		if ( 'POST' === $args['method'] && '/v1/refunds' === $path ) {
			$body                 = json_decode( (string) $args['body'], true );
			$this->refund_posts[] = $body;
			if ( array() !== $this->refund_replies ) {
				$reply = array_shift( $this->refund_replies );
				return self::response( $reply[0], $reply[1] );
			}
			++$this->refund_seq;
			return self::response(
				201,
				array(
					'id'                  => 'ref_' . $this->refund_seq,
					'status'              => 'pending',
					'amount_usd'          => $body['amount'],
					'refund_external_ref' => $body['external_ref'],
					'payment_id'          => $body['payment'],
					'created'             => time(),
				)
			);
		}
		return self::response( 500, null );
	}

	/**
	 * An API error body.
	 *
	 * @param string $code    Code.
	 * @param string $message Message.
	 */
	private static function api_error( string $code, string $message ): array {
		return array(
			'error' => array(
				'code'      => $code,
				'message'   => $message,
				'requestId' => 'req_1',
			),
		);
	}

	// ---------------------------------------------------------------- fixtures.

	/**
	 * A tendr order paid by PAYMENT_ID (49.00 USD: 2 × 24.50), as Task 10 leaves it.
	 *
	 * @param array $opts livemode (bool, how it was paid), stock (bool).
	 */
	private function paid_order( array $opts = array() ): WC_Order {
		$product = new WC_Product_Simple();
		$product->set_regular_price( '24.50' );
		if ( ! empty( $opts['stock'] ) ) {
			$product->set_manage_stock( true );
			$product->set_stock_quantity( 8 );
		}
		$product->save();

		$order = wc_create_order();
		$order->set_currency( 'USD' );
		$order->set_billing_email( 'ada@example.com' );
		$order->set_payment_method( 'tendr' );
		$order->add_product( $product, 2 );
		$order->calculate_totals( false );
		$order->set_status( 'pending' );
		$order->save();
		$order->update_meta_data( Tendr_Gateway::META_EXTERNAL_REF, Tendr_Gateway::external_ref( $order->get_id() ) );
		$order->update_meta_data( Tendr_Gateway::META_SESSION_ID, self::SESSION_ID );
		$order->update_meta_data( Tendr_Gateway::META_MODE, ! empty( $opts['livemode'] ) ? 'live' : 'test' );
		$order->update_meta_data( Tendr_Order_Sync::META_PAID_LIVEMODE, ! empty( $opts['livemode'] ) ? 'yes' : 'no' );
		$order->save();
		$order->payment_complete( self::PAYMENT_ID );
		reset_phpmailer_instance();
		return wc_get_order( $order->get_id() );
	}

	/**
	 * The session view with the payment and its refunds.
	 *
	 * @param WC_Order $order   Order.
	 * @param array    $refunds Refund views: id => status.
	 * @param bool     $live    Livemode.
	 */
	private function session( WC_Order $order, array $refunds = array(), bool $live = false ): array {
		$rows = array();
		foreach ( $refunds as $id => $status ) {
			$rows[] = array(
				'id'                => $id,
				'reason'            => 'merchant',
				'status'            => $status,
				'asset_id'          => 'nep141:usdc.near',
				'amount'            => '10050000',
				'destination'       => 'ada.near',
				'destination_chain' => 'near',
				'needs_address'     => false,
				'refund_tx_hash'    => 'confirmed' === $status ? 'RefTx123' : null,
				'created_at'        => '2026-10-26T10:00:00.000Z',
			);
		}
		$view                          = array(
			'id'                => self::SESSION_ID,
			'livemode'          => $live,
			'status'            => 'SETTLED',
			'amount'            => '49.00',
			'amount_currency'   => 'USD',
			'original_amount'   => null,
			'original_currency' => null,
			'fx'                => null,
			'external_ref'      => Tendr_Gateway::external_ref( $order->get_id() ),
			'metadata'          => array(
				'order_number' => (string) $order->get_order_number(),
				'order_key'    => $order->get_order_key(),
				'site_url'     => home_url(),
			),
			'expires_at'        => gmdate( 'Y-m-d\TH:i:s.000\Z', time() - 600 ),
			'payments'          => array(
				array(
					'id'                     => self::PAYMENT_ID,
					'status'                 => 'PARTIALLY_REFUNDED',
					'is_late'                => false,
					'held_reason'            => null,
					'amount_received'        => '49000000',
					'amount_out'             => '49000000',
					'amount_in_usd'          => '49.00',
					'overpaid_amount'        => null,
					'refunded_amount'        => null,
					'kept_small_overpayment' => false,
					'origin_tx_hash'         => 'PayTx123',
					'sender_chain'           => 'near',
					'settled_at'             => '2026-10-26T09:00:00.000Z',
					'refunds'                => $rows,
				),
			),
		);
		$this->sessions[ $view['id'] ] = $view;
		return $view;
	}

	/**
	 * A WooCommerce admin refund that asks the gateway to refund the payment.
	 *
	 * @param WC_Order $order  Order.
	 * @param string   $amount Amount.
	 * @param array    $extra  More wc_create_refund() args.
	 * @return WC_Order_Refund|WP_Error
	 */
	private static function refund( WC_Order $order, string $amount, array $extra = array() ) {
		return wc_create_refund(
			array_merge(
				array(
					'order_id'       => $order->get_id(),
					'amount'         => $amount,
					'reason'         => 'Damaged',
					'refund_payment' => true,
				),
				$extra
			)
		);
	}

	/**
	 * The WooCommerce refund id that the last refund request used (from its external_ref).
	 */
	private function last_wc_refund_id(): int {
		$body = end( $this->refund_posts );
		$this->assertMatchesRegularExpression( '/^wc_refund_\d+$/', (string) $body['external_ref'] );
		return (int) substr( (string) $body['external_ref'], strlen( 'wc_refund_' ) );
	}

	/**
	 * A refund.* event for a requested refund.
	 *
	 * @param string   $type         Event type.
	 * @param WC_Order $order        Order.
	 * @param string   $tendr_id     Tendr refund id.
	 * @param int      $wc_refund_id The WooCommerce refund id (external_ref).
	 * @param array    $over         Top-level overrides.
	 */
	private static function refund_event( string $type, WC_Order $order, string $tendr_id, int $wc_refund_id, array $over = array() ): array {
		++self::$seq;
		return array_merge(
			array(
				'id'       => sprintf( 'evt_01JREFUND%017d', self::$seq ),
				'type'     => $type,
				'created'  => time(),
				'livemode' => false,
				'data'     => array(
					'refund_id'           => $tendr_id,
					'payment_id'          => self::PAYMENT_ID,
					'session_id'          => self::SESSION_ID,
					'external_ref'        => Tendr_Gateway::external_ref( $order->get_id() ),
					'refund_external_ref' => 'wc_refund_' . $wc_refund_id,
					'asset'               => 'nep141:usdc.near',
					'amount'              => '10050000',
					'reason'              => 'merchant',
					'proposal_id'         => 'prop_1',
				),
			),
			$over
		);
	}

	/**
	 * Sign and deliver an event to the receiver.
	 *
	 * @param array $event Event.
	 */
	private function deliver( array $event ): WP_REST_Response {
		$body    = (string) wp_json_encode( $event );
		$secret  = $event['livemode'] ? $this->issued['live']['webhook_secret'] : $this->issued['test']['webhook_secret'];
		$t       = time();
		$request = new WP_REST_Request( 'POST', '/tendr/v1/webhook' );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_header( 'Tendr-Signature', 't=' . $t . ',v1=' . hash_hmac( 'sha256', $t . '.' . $body, $secret ) );
		$request->set_body( $body );
		return rest_get_server()->dispatch( $request );
	}

	/**
	 * The order's notes, newest first.
	 *
	 * @param WC_Order $order Order.
	 * @return string[]
	 */
	private static function notes( WC_Order $order ): array {
		return array_map( static fn( $n ) => (string) $n->content, wc_get_order_notes( array( 'order_id' => $order->get_id() ) ) );
	}

	/**
	 * The order, fresh from the store.
	 *
	 * @param WC_Order $order Order.
	 */
	private static function fresh( WC_Order $order ): WC_Order {
		return wc_get_order( $order->get_id() );
	}

	/**
	 * Subjects of the emails sent since the last reset.
	 *
	 * @return string[]
	 */
	private static function mail_subjects(): array {
		$mailer = tests_retrieve_phpmailer_instance();
		return array_map( static fn( $m ) => (string) $m['subject'], $mailer->mock_sent );
	}

	/**
	 * Whether any email mentions a refund.
	 */
	private static function refund_mail_sent(): bool {
		foreach ( self::mail_subjects() as $subject ) {
			if ( false !== stripos( $subject, 'refund' ) ) {
				return true;
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- requesting a refund.

	public function test_process_refund_posts_exact_body_and_leaves_order_not_refunded(): void {
		$order = $this->paid_order();

		$result = self::refund( $order, '10.00' );

		$this->assertNotWPError( $result );
		$this->assertCount( 1, $this->refund_posts );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->assertGreaterThan( 0, $wc_refund_id );
		$this->assertSame(
			array(
				'payment'      => self::PAYMENT_ID,
				'amount'       => '10',
				'currency'     => 'USD',
				'reason'       => 'Damaged',
				'external_ref' => 'wc_refund_' . $wc_refund_id,
			),
			$this->refund_posts[0]
		);
		$request = end( $this->requests );
		$this->assertSame( 'Bearer ' . $this->issued['test']['secret_key'], $request['args']['headers']['Authorization'] );
		$this->assertSame( 'wc_refund_' . $wc_refund_id, $request['args']['headers']['Idempotency-Key'] );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertSame( array(), $order->get_refunds(), 'no WooCommerce refund until tendr sends the money' );
		$this->assertEquals( 0, $order->get_total_refunded() );
		$this->assertStringContainsString( 'awaiting approval in tendr', self::notes( $order )[0] );
		$this->assertStringContainsString( '$10.00', self::notes( $order )[0] );
		$this->assertStringContainsString( '/dashboard/approvals', self::notes( $order )[0] );

		$pending = Tendr_Refunds::requests( $order );
		$this->assertSame( 'ref_1', $pending[ $wc_refund_id ]['refund_id'] );
		$this->assertSame( 'pending', $pending[ $wc_refund_id ]['state'] );
		$this->assertSame( '10.00', $pending[ $wc_refund_id ]['amount'] );
		$this->assertFalse( self::refund_mail_sent() );
	}

	public function test_full_refund_is_not_refunded_and_sends_no_email_until_sent(): void {
		$order = $this->paid_order();

		$this->assertNotWPError( self::refund( $order, '49.00' ) );
		$wc_refund_id = $this->last_wc_refund_id();

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status(), 'never Refunded before refund.sent' );
		$this->assertEquals( 0, $order->get_total_refunded() );
		$this->assertFalse( self::refund_mail_sent(), 'no refunded email before the money leaves' );

		// The money leaves: now it is Refunded, and the customer is told.
		$this->session( $order, array( 'ref_1' => 'confirmed' ) );
		$this->assertSame( 200, $this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) )->get_status() );

		$order = self::fresh( $order );
		$this->assertSame( 'refunded', $order->get_status() );
		$this->assertEquals( 49, $order->get_total_refunded() );
		$this->assertTrue( self::refund_mail_sent(), 'the refunded email goes out once the refund is sent' );
	}

	public function test_refund_sent_records_a_partial_refund_with_correct_totals(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();

		$this->session( $order, array( 'ref_1' => 'confirmed' ) );
		$this->assertSame( 200, $this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) )->get_status() );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertEquals( 10, $order->get_total_refunded() );
		$refunds = $order->get_refunds();
		$this->assertCount( 1, $refunds );
		$this->assertSame( 'ref_1', $refunds[0]->get_meta( '_tendr_refund_id' ) );
		$this->assertSame( 'sent', $refunds[0]->get_meta( '_tendr_refund_state' ) );
		$this->assertSame( 'Damaged', $refunds[0]->get_reason() );
		$this->assertSame( 'sent', Tendr_Refunds::requests( $order )[ $wc_refund_id ]['state'] );
		$this->assertStringContainsString( 'sent', self::notes( $order )[0] );
		$this->assertStringContainsString( '[Test]', self::notes( $order )[0] );

		// A replayed refund.sent (new event id) records nothing more.
		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) );
		$this->assertEquals( 10, self::fresh( $order )->get_total_refunded() );
		$this->assertCount( 1, self::fresh( $order )->get_refunds() );
	}

	public function test_refund_cancelled_removes_the_pending_refund_and_leaves_totals_unchanged(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();

		$this->session( $order, array( 'ref_1' => 'pending' ) );
		$this->assertSame( 200, $this->deliver( self::refund_event( 'refund.cancelled', $order, 'ref_1', $wc_refund_id ) )->get_status() );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertEquals( 0, $order->get_total_refunded() );
		$this->assertSame( array(), $order->get_refunds() );
		$this->assertSame( 'cancelled', Tendr_Refunds::requests( $order )[ $wc_refund_id ]['state'] );
		$this->assertSame( '0', Tendr_Refunds::pending_total( $order ) );
		$this->assertStringContainsString( 'not approved', self::notes( $order )[0] );
	}

	public function test_refund_failed_leaves_totals_unchanged(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();

		$this->session( $order, array( 'ref_1' => 'failed' ) );
		$this->deliver( self::refund_event( 'refund.failed', $order, 'ref_1', $wc_refund_id ) );

		$order = self::fresh( $order );
		$this->assertEquals( 0, $order->get_total_refunded() );
		$this->assertSame( 'failed', Tendr_Refunds::requests( $order )[ $wc_refund_id ]['state'] );
		$this->assertStringContainsString( 'could not be sent', self::notes( $order )[0] );
	}

	public function test_two_partial_refunds_then_one_cancelled_totals_reflect_only_sent(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$first = $this->last_wc_refund_id();
		self::refund( $order, '15.00' );
		$second = $this->last_wc_refund_id();
		$this->assertNotSame( $first, $second );
		$this->assertSame( '25', Tendr_Refunds::pending_total( self::fresh( $order ) ) );
		$this->assertEquals( 0, self::fresh( $order )->get_total_refunded() );

		$this->session(
			$order,
			array(
				'ref_1' => 'confirmed',
				'ref_2' => 'pending',
			)
		);
		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $first ) );
		$this->assertEquals( 10, self::fresh( $order )->get_total_refunded() );

		$this->deliver( self::refund_event( 'refund.cancelled', $order, 'ref_2', $second ) );

		$order = self::fresh( $order );
		$this->assertEquals( 10, $order->get_total_refunded(), 'only the sent refund counts' );
		$this->assertCount( 1, $order->get_refunds() );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertSame( '0', Tendr_Refunds::pending_total( $order ) );
	}

	// ---------------------------------------------------------------- R2: sent is final.

	public function test_a_late_cancelled_after_sent_does_not_undo_the_refund(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->session( $order, array( 'ref_1' => 'confirmed' ) );
		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) );

		foreach ( array( 'refund.cancelled', 'refund.failed' ) as $type ) {
			$this->assertSame( 200, $this->deliver( self::refund_event( $type, $order, 'ref_1', $wc_refund_id ) )->get_status() );
		}

		$order = self::fresh( $order );
		$this->assertEquals( 10, $order->get_total_refunded() );
		$this->assertCount( 1, $order->get_refunds() );
		$this->assertSame( 'sent', Tendr_Refunds::requests( $order )[ $wc_refund_id ]['state'] );
	}

	public function test_cancelled_whose_reread_shows_it_sent_changes_nothing(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->session( $order, array( 'ref_1' => 'confirmed' ) );

		$this->deliver( self::refund_event( 'refund.cancelled', $order, 'ref_1', $wc_refund_id ) );

		$this->assertSame( 'pending', Tendr_Refunds::requests( self::fresh( $order ) )[ $wc_refund_id ]['state'] );
	}

	public function test_sent_after_cancelled_is_still_applied(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->session( $order, array( 'ref_1' => 'pending' ) );
		$this->deliver( self::refund_event( 'refund.cancelled', $order, 'ref_1', $wc_refund_id ) );
		$this->assertEquals( 0, self::fresh( $order )->get_total_refunded() );

		// The proposal was revived and executed after all: the money left.
		$this->session( $order, array( 'ref_1' => 'confirmed' ) );
		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) );

		$order = self::fresh( $order );
		$this->assertEquals( 10, $order->get_total_refunded() );
		$this->assertSame( 'sent', Tendr_Refunds::requests( $order )[ $wc_refund_id ]['state'] );
	}

	// ---------------------------------------------------------------- re-read authority and retries.

	public function test_sent_whose_reread_is_not_confirmed_changes_nothing(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->session( $order, array( 'ref_1' => 'pending' ) );

		$this->assertSame( 200, $this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) )->get_status() );

		$this->assertEquals( 0, self::fresh( $order )->get_total_refunded() );
		$this->assertSame( 'pending', Tendr_Refunds::requests( self::fresh( $order ) )[ $wc_refund_id ]['state'] );
	}

	public function test_a_transient_reread_failure_is_retried_and_not_recorded_as_seen(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->session( $order, array( 'ref_1' => 'confirmed' ) );
		$event = self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id );

		$this->get_reply = array( 503, self::api_error( 'INTERNAL_ERROR', 'Try again' ) );
		$this->assertSame( 503, $this->deliver( $event )->get_status() );
		$this->assertEquals( 0, self::fresh( $order )->get_total_refunded() );

		// Tendr retries the same event id: it is applied.
		$this->get_reply = null;
		$this->assertSame( 200, $this->deliver( $event )->get_status() );
		$this->assertEquals( 10, self::fresh( $order )->get_total_refunded() );
	}

	public function test_apply_refund_event_returns_an_error_when_the_refund_cannot_be_recorded(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$view         = $this->session( $order, array( 'ref_1' => 'confirmed' ) );
		add_filter(
			'woocommerce_create_refund',
			static function () {
				throw new Exception( 'Database is away' );
			}
		);

		$result = Tendr_Order_Sync::apply_refund_event( self::fresh( $order ), self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ), $view );

		$this->assertWPError( $result );
		$this->assertSame( 'pending', Tendr_Refunds::requests( self::fresh( $order ) )[ $wc_refund_id ]['state'] );
	}

	public function test_an_event_whose_tendr_refund_id_does_not_match_changes_nothing(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->session( $order, array( 'ref_other' => 'confirmed' ) );

		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_other', $wc_refund_id ) );

		$this->assertEquals( 0, self::fresh( $order )->get_total_refunded() );
		$this->assertSame( 'pending', Tendr_Refunds::requests( self::fresh( $order ) )[ $wc_refund_id ]['state'] );
	}

	// ---------------------------------------------------------------- stock.

	public function test_restock_waits_until_the_refund_is_sent(): void {
		$order = $this->paid_order( array( 'stock' => true ) );
		$items = $order->get_items();
		$item  = reset( $items );
		$this->assertSame( 6, wc_get_product( $item->get_product_id() )->get_stock_quantity(), '8 in stock, 2 sold' );

		self::refund(
			$order,
			'24.50',
			array(
				'restock_items' => true,
				'line_items'    => array(
					$item->get_id() => array(
						'qty'          => 1,
						'refund_total' => '24.50',
					),
				),
			)
		);
		$wc_refund_id = $this->last_wc_refund_id();
		$this->assertSame( 6, wc_get_product( $item->get_product_id() )->get_stock_quantity(), 'nothing is restocked while the refund awaits approval' );

		$this->session( $order, array( 'ref_1' => 'confirmed' ) );
		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_1', $wc_refund_id ) );

		$this->assertSame( 7, wc_get_product( $item->get_product_id() )->get_stock_quantity() );
		$this->assertSame( -1, self::fresh( $order )->get_qty_refunded_for_item( $item->get_id() ) );
	}

	// ---------------------------------------------------------------- limits and errors.

	public function test_pending_refunds_count_against_what_can_still_be_refunded(): void {
		$order = $this->paid_order();
		$this->assertNotWPError( self::refund( $order, '30.00' ) );

		$second = self::refund( $order, '30.00' );

		$this->assertWPError( $second );
		$this->assertStringContainsString( 'awaiting approval', $second->get_error_message() );
		$this->assertCount( 1, $this->refund_posts, 'no second request reaches tendr' );
		$this->assertEquals( 0, self::fresh( $order )->get_total_refunded() );
	}

	public function test_an_api_refusal_is_shown_and_nothing_is_recorded(): void {
		$order                = $this->paid_order();
		$this->refund_replies = array( array( 409, self::api_error( 'AMOUNT_EXCEEDS_REFUNDABLE', 'Only 5.00 USD can still be refunded' ) ) );

		$result = self::refund( $order, '10.00' );

		$this->assertWPError( $result );
		$this->assertStringContainsString( 'more than tendr can still refund', $result->get_error_message() );
		$order = self::fresh( $order );
		$this->assertSame( array(), Tendr_Refunds::requests( $order ) );
		$this->assertSame( array(), $order->get_refunds() );
	}

	public function test_an_unconfirmed_request_is_adopted_when_its_events_arrive(): void {
		$order                = $this->paid_order();
		$this->refund_replies = array( array( 502, null ) );

		$result = self::refund( $order, '10.00' );

		$this->assertWPError( $result );
		$wc_refund_id = $this->last_wc_refund_id();
		$this->assertSame( 'unconfirmed', Tendr_Refunds::requests( self::fresh( $order ) )[ $wc_refund_id ]['state'] );
		$this->assertStringContainsString( 'Check the tendr dashboard', self::notes( self::fresh( $order ) )[0] );

		// tendr did create it after all.
		$this->session( $order, array( 'ref_9' => 'confirmed' ) );
		$this->deliver( self::refund_event( 'refund.sent', $order, 'ref_9', $wc_refund_id ) );

		$this->assertEquals( 10, self::fresh( $order )->get_total_refunded() );
		$this->assertSame( 'ref_9', Tendr_Refunds::requests( self::fresh( $order ) )[ $wc_refund_id ]['refund_id'] );
	}

	public function test_a_refund_needing_review_says_so(): void {
		$order                = $this->paid_order();
		$this->refund_replies = array(
			array(
				201,
				array(
					'id'                  => 'ref_7',
					'status'              => 'review',
					'amount_usd'          => '10.00',
					'refund_external_ref' => 'x',
					'payment_id'          => self::PAYMENT_ID,
					'created'             => time(),
				),
			),
		);

		$this->assertNotWPError( self::refund( $order, '10.00' ) );

		$order = self::fresh( $order );
		$note  = self::notes( $order )[0];
		$this->assertStringContainsString( 'manual review in tendr', $note );
		$this->assertStringContainsString( 'settlement', $note );
		$this->assertStringContainsString( '/dashboard/review', $note );
		$this->assertSame( 'review', Tendr_Refunds::requests( $order )[ $this->last_wc_refund_id() ]['state'] );
		$this->assertEquals( 0, $order->get_total_refunded() );
	}

	// ---------------------------------------------------------------- R6: who, and which key.

	public function test_a_test_paid_order_is_refunded_with_the_test_key_in_live_mode(): void {
		$order = $this->paid_order();
		update_option( Tendr_Connect::MODE, 'live' );

		$this->assertNotWPError( self::refund( $order, '10.00' ) );

		$request = end( $this->requests );
		$this->assertSame( 'Bearer ' . $this->issued['test']['secret_key'], $request['args']['headers']['Authorization'] );
	}

	public function test_a_live_paid_order_is_refunded_with_the_live_key_in_test_mode(): void {
		$order = $this->paid_order( array( 'livemode' => true ) );

		$this->assertNotWPError( self::refund( $order, '10.00' ) );

		$request = end( $this->requests );
		$this->assertSame( 'Bearer ' . $this->issued['live']['secret_key'], $request['args']['headers']['Authorization'] );
		$this->assertStringNotContainsString( '[Test]', self::notes( self::fresh( $order ) )[0] );
	}

	public function test_only_store_managers_can_refund(): void {
		$order = $this->paid_order();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );

		$result = self::refund( $order, '10.00' );

		$this->assertWPError( $result );
		$this->assertSame( array(), $this->refund_posts );
	}

	public function test_an_order_not_paid_by_tendr_cannot_be_refunded_through_tendr(): void {
		$order = $this->paid_order();
		$order->set_transaction_id( '' );
		$order->save();

		$gateway = new Tendr_Gateway();
		$this->assertTrue( $gateway->supports( 'refunds' ) );
		$this->assertFalse( $gateway->can_refund_order( self::fresh( $order ) ) );
		$this->assertWPError( self::refund( self::fresh( $order ), '10.00' ) );
		$this->assertSame( array(), $this->refund_posts );
	}

	public function test_pending_refunds_are_shown_on_the_order_screen(): void {
		$order = $this->paid_order();
		self::refund( $order, '10.00' );

		ob_start();
		Tendr_Refunds::render_pending( self::fresh( $order ) );
		$html = (string) ob_get_clean();

		$this->assertStringContainsString( 'awaiting approval in tendr', $html );
		$this->assertStringContainsString( '10.00', $html );
	}
}
