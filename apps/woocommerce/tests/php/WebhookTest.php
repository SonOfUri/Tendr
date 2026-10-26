<?php
/**
 * The signed webhook receiver and the order status sync (spec §6).
 *
 * @package Tendr
 */

/**
 * `POST /wp-json/tendr/v1/webhook` and Tendr_Order_Sync.
 */
class WebhookTest extends Tendr_Test_Case {

	const SESSION_ID     = 'ses_01JWEBHOOKSESSION000000000';
	const OLD_SESSION_ID = 'ses_01JWEBHOOKSESSIONOLD00000';
	const PAYMENT_ID     = 'pay_01JWEBHOOKPAYMENT000000000';
	const TX_HASH        = 'AbCdEf1234567890';

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
	 * A counter for unique event ids.
	 *
	 * @var int
	 */
	private static int $seq = 0;

	public function set_up(): void {
		parent::set_up();
		$this->issued    = self::connect_locally();
		$this->sessions  = array();
		$this->get_reply = null;
		update_option( 'woocommerce_manage_stock', 'yes' );
		$this->mock_http( fn( $url, $args ) => $this->api( $url, $args ) );
	}

	/**
	 * The mocked tendr API: `GET /v1/checkout/sessions/:id` only.
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
			if ( isset( $this->sessions[ $m[1] ] ) ) {
				return self::response( 200, $this->sessions[ $m[1] ] );
			}
			return self::response(
				404,
				array(
					'error' => array(
						'code'      => 'NOT_FOUND',
						'message'   => 'Session not found',
						'requestId' => 'req_1',
					),
				)
			);
		}
		return self::response( 500, null );
	}

	// ---------------------------------------------------------------- fixtures.

	/**
	 * A tendr order with a session, as Task 9's checkout leaves it.
	 *
	 * @param array $opts virtual (bool), session (string), mode ('test'|'live'), stock (bool).
	 */
	private function order( array $opts = array() ): WC_Order {
		$order = wc_create_order();
		$order->set_currency( $opts['currency'] ?? 'USD' );
		$order->set_billing_email( 'ada@example.com' );
		$order->set_payment_method( 'tendr' );
		$order->set_created_via( 'checkout' );
		if ( empty( $opts['fee_only'] ) ) {
			// A physical product by default: WooCommerce completes orders that need no processing.
			$product = new WC_Product_Simple();
			$product->set_regular_price( '24.50' );
			if ( ! empty( $opts['virtual'] ) ) {
				$product->set_virtual( true );
				$product->set_downloadable( true );
			}
			if ( ! empty( $opts['stock'] ) ) {
				$product->set_manage_stock( true );
				$product->set_stock_quantity( 10 );
			}
			$product->save();
			$order->add_product( $product, 2 );
		} else {
			$fee = new WC_Order_Item_Fee();
			$fee->set_name( 'Goods' );
			$fee->set_total( '49.00' );
			$order->add_item( $fee );
		}
		$order->calculate_totals( false );
		$order->set_status( 'pending' );
		$order->save();
		$order->update_meta_data( Tendr_Gateway::META_EXTERNAL_REF, Tendr_Gateway::external_ref( $order->get_id() ) );
		$order->update_meta_data( Tendr_Gateway::META_SESSION_ID, $opts['session'] ?? self::SESSION_ID );
		$order->update_meta_data( Tendr_Gateway::META_MODE, $opts['mode'] ?? 'test' );
		$order->save();
		if ( ! empty( $opts['stock'] ) ) {
			// As wc_maybe_reduce_stock_levels() leaves a store that reduces stock at checkout.
			wc_reduce_stock_levels( $order->get_id() );
			$order->get_data_store()->set_stock_reduced( $order->get_id(), true );
		}
		return wc_get_order( $order->get_id() );
	}

	/**
	 * A session GET view for an order.
	 *
	 * @param WC_Order $order    Order.
	 * @param string   $status   Session status.
	 * @param array    $payments Payment views (merged over defaults).
	 * @param array    $extra    Session fields to override.
	 */
	private function session( WC_Order $order, string $status, array $payments = array(), array $extra = array() ): array {
		$view                          = array_merge(
			array(
				'id'                => self::SESSION_ID,
				'livemode'          => false,
				'status'            => $status,
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
				'expires_at'        => gmdate( 'Y-m-d\TH:i:s.000\Z', time() + 600 ),
				'payments'          => array_map( array( self::class, 'payment' ), $payments ),
			),
			$extra
		);
		$this->sessions[ $view['id'] ] = $view;
		return $view;
	}

	/**
	 * A payment view.
	 *
	 * @param array $over Fields to override.
	 */
	private static function payment( array $over ): array {
		return array_merge(
			array(
				'id'                     => self::PAYMENT_ID,
				'status'                 => 'SETTLED',
				'is_late'                => false,
				'held_reason'            => null,
				'amount_received'        => '9900000000000000000000000',
				'amount_out'             => '49000000',
				'amount_in_usd'          => '49.00',
				'overpaid_amount'        => null,
				'refunded_amount'        => null,
				'kept_small_overpayment' => false,
				'origin_tx_hash'         => self::TX_HASH,
				'sender_chain'           => 'near',
				'settled_at'             => '2026-10-26T10:00:00.000Z',
				'refunds'                => array(),
			),
			$over
		);
	}

	/**
	 * A webhook event body, as the API's webhookBody() builds it.
	 *
	 * @param string   $type  Event type.
	 * @param WC_Order $order Order.
	 * @param array    $data  Extra data.
	 * @param array    $over  Top-level overrides (id, livemode, created).
	 */
	private static function event( string $type, WC_Order $order, array $data = array(), array $over = array() ): array {
		++self::$seq;
		return array_merge(
			array(
				'id'       => sprintf( 'evt_01JWEBHOOK%016d', self::$seq ),
				'type'     => $type,
				'created'  => time(),
				'livemode' => false,
				'data'     => array_merge(
					array(
						'payment_id'   => self::PAYMENT_ID,
						'session_id'   => self::SESSION_ID,
						'external_ref' => Tendr_Gateway::external_ref( $order->get_id() ),
						'origin_asset' => 'nep141:wrap.near',
					),
					$data
				),
			),
			$over
		);
	}

	/**
	 * `t=<t>,v1=<hmac>` for each secret, as the API signs.
	 *
	 * @param string   $body    Raw body.
	 * @param string[] $secrets Secrets (several during a rotation overlap).
	 * @param int|null $t       Timestamp.
	 */
	private static function sign( string $body, array $secrets, ?int $t = null ): string {
		$t      = $t ?? time();
		$header = 't=' . $t;
		foreach ( $secrets as $secret ) {
			$header .= ',v1=' . hash_hmac( 'sha256', $t . '.' . $body, $secret );
		}
		return $header;
	}

	/**
	 * POST a raw body to the receiver.
	 *
	 * @param string      $body   Raw body.
	 * @param string|null $header Tendr-Signature (null: none).
	 */
	private static function post( string $body, ?string $header ): WP_REST_Response {
		$request = new WP_REST_Request( 'POST', '/tendr/v1/webhook' );
		$request->set_header( 'Content-Type', 'application/json' );
		if ( null !== $header ) {
			$request->set_header( 'Tendr-Signature', $header );
		}
		$request->set_body( $body );
		return rest_get_server()->dispatch( $request );
	}

	/**
	 * Sign an event with the test (or live) webhook secret and deliver it.
	 *
	 * @param array    $event Event.
	 * @param int|null $t     Timestamp.
	 */
	private function deliver( array $event, ?int $t = null ): WP_REST_Response {
		$body   = (string) wp_json_encode( $event );
		$secret = $event['livemode'] ? $this->issued['live']['webhook_secret'] : $this->issued['test']['webhook_secret'];
		return self::post( $body, self::sign( $body, array( $secret ), $t ) );
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
	 * Session GETs made.
	 */
	private function gets(): int {
		return count( array_filter( $this->requests, static fn( $r ) => 'GET' === $r['args']['method'] ) );
	}

	// ---------------------------------------------------------------- signatures.

	public function test_bad_signature_is_rejected_with_400_and_no_change(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$body = (string) wp_json_encode( self::event( 'payment.succeeded', $order ) );

		$response = self::post( $body, self::sign( $body, array( 'whsec_not_the_secret' ) ) );

		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
		$this->assertSame( 0, $this->gets(), 'nothing is read before the signature checks out' );
	}

	public function test_a_tampered_body_is_rejected(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$body = (string) wp_json_encode( self::event( 'payment.succeeded', $order ) );
		$sig  = self::sign( $body, array( $this->issued['test']['webhook_secret'] ) );

		$response = self::post( $body . ' ', $sig );

		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
	}

	public function test_missing_or_garbled_headers_are_rejected_with_400(): void {
		$order = $this->order();
		$body  = (string) wp_json_encode( self::event( 'payment.succeeded', $order ) );
		$good  = hash_hmac( 'sha256', time() . '.' . $body, $this->issued['test']['webhook_secret'] );

		foreach ( array(
			null,
			'',
			'garbage',
			'v1=' . $good,
			't=' . time(),
			't=' . time() . ',v1=' . strtoupper( $good ),
			't=0' . time() . ',v1=' . $good,
			't=' . time() . ',t=' . time() . ',v1=' . $good,
			't=abc,v1=' . $good,
		) as $header ) {
			$this->assertSame( 400, self::post( $body, $header )->get_status(), (string) $header );
		}
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
	}

	public function test_a_timestamp_six_minutes_old_or_ahead_is_rejected(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );

		$this->assertSame( 400, $this->deliver( self::event( 'payment.succeeded', $order ), time() - 360 )->get_status() );
		$this->assertSame( 400, $this->deliver( self::event( 'payment.succeeded', $order ), time() + 360 )->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );

		$this->assertSame( 200, $this->deliver( self::event( 'payment.succeeded', $order ), time() - 290 )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	public function test_rotation_overlap_accepts_either_v1(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$secret = $this->issued['test']['webhook_secret'];

		$event = self::event( 'payment.succeeded', $order );
		$body  = (string) wp_json_encode( $event );
		// The site knows the old secret; the API signs with the new one first, then the old one.
		$this->assertSame( 200, self::post( $body, self::sign( $body, array( 'whsec_new_secret_after_rotation', $secret ) ) )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );

		$order2 = $this->order();
		$this->session( $order2, 'SETTLED', array( array() ) );
		$body2 = (string) wp_json_encode( self::event( 'payment.succeeded', $order2 ) );
		$this->assertSame( 200, self::post( $body2, self::sign( $body2, array( $secret, 'whsec_old_secret' ) ) )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order2 )->get_status() );
	}

	public function test_the_events_livemode_picks_the_secret(): void {
		$order = $this->order( array( 'mode' => 'test' ) );
		$this->session( $order, 'SETTLED', array( array() ), array( 'livemode' => true ) );
		$event = self::event( 'payment.succeeded', $order, array(), array( 'livemode' => true ) );
		$body  = (string) wp_json_encode( $event );

		// A live event signed with the test secret is not authentic.
		$this->assertSame( 400, self::post( $body, self::sign( $body, array( $this->issued['test']['webhook_secret'] ) ) )->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );

		// Signed with the live secret it is, whatever mode the order was started in; the re-read uses the live key.
		$this->assertSame( 200, self::post( $body, self::sign( $body, array( $this->issued['live']['webhook_secret'] ) ) )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
		$get = array_values( array_filter( $this->requests, static fn( $r ) => 'GET' === $r['args']['method'] ) );
		$this->assertSame( 'Bearer ' . $this->issued['live']['secret_key'], $get[0]['args']['headers']['Authorization'] );
	}

	public function test_responses_are_minimal_and_never_echo_secrets_or_order_data(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$ok  = $this->deliver( self::event( 'payment.succeeded', $order ) );
		$bad = self::post( '{}', 't=1,v1=' . str_repeat( 'a', 64 ) );

		foreach ( array( $ok, $bad ) as $response ) {
			$json = (string) wp_json_encode( $response->get_data() );
			foreach ( self::secrets_of( $this->issued ) as $secret ) {
				$this->assertStringNotContainsString( $secret, $json );
			}
			$this->assertStringNotContainsString( $order->get_order_key(), $json );
			$this->assertStringNotContainsString( 'wc_', $json );
		}
		$this->assertSame( array( 'received' => true ), $ok->get_data() );
	}

	public function test_the_route_is_public_and_post_only(): void {
		$routes = rest_get_server()->get_routes();
		$this->assertArrayHasKey( '/tendr/v1/webhook', $routes );
		$get = rest_get_server()->dispatch( new WP_REST_Request( 'GET', '/tendr/v1/webhook' ) );
		$this->assertSame( 404, $get->get_status() );
	}

	// ---------------------------------------------------------------- idempotency.

	public function test_a_duplicate_event_id_changes_the_order_once(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$event = self::event( 'payment.succeeded', $order );

		$this->assertSame( 200, $this->deliver( $event )->get_status() );
		$notes = count( self::notes( $order ) );
		$this->assertSame( 200, $this->deliver( $event )->get_status() );

		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
		$this->assertCount( $notes, self::notes( $order ) );
		$this->assertSame( 1, $this->gets(), 'a seen event is not re-read' );
	}

	public function test_an_event_claimed_by_a_concurrent_delivery_is_retried_later(): void {
		global $wpdb;
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$event = self::event( 'payment.succeeded', $order );
		Tendr_Webhooks::ensure_table();
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			Tendr_Webhooks::table(),
			array(
				'event_id'    => $event['id'],
				'received_at' => gmdate( 'Y-m-d H:i:s' ),
				'state'       => 0,
			)
		);

		$response = $this->deliver( $event );

		$this->assertSame( 409, $response->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
	}

	public function test_a_stale_claim_is_taken_over(): void {
		global $wpdb;
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$event = self::event( 'payment.succeeded', $order );
		Tendr_Webhooks::ensure_table();
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			Tendr_Webhooks::table(),
			array(
				'event_id'    => $event['id'],
				'received_at' => gmdate( 'Y-m-d H:i:s', time() - 600 ),
				'state'       => 0,
			)
		);

		$this->assertSame( 200, $this->deliver( $event )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	public function test_succeeded_then_processing_replay_stays_processing(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$this->deliver( self::event( 'payment.succeeded', $order ) );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );

		$this->assertSame( 200, $this->deliver( self::event( 'payment.processing', $order ) )->get_status() );
		$this->assertSame( 200, $this->deliver( self::event( 'payment.detected', $order ) )->get_status() );

		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	public function test_a_transient_re_read_failure_returns_503_and_the_retry_applies(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$event           = self::event( 'payment.succeeded', $order );
		$this->get_reply = array( 503, null );

		$this->assertSame( 503, $this->deliver( $event )->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );

		$this->get_reply = null;
		$this->assertSame( 200, $this->deliver( $event )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	// ---------------------------------------------------------------- lookup.

	public function test_an_unknown_order_is_acknowledged_and_logged(): void {
		$logged = array();
		add_action(
			'tendr_webhook_log',
			static function ( $entry ) use ( &$logged ) {
				$logged[] = $entry;
			}
		);
		$order = $this->order();
		$event = self::event( 'payment.succeeded', $order, array( 'external_ref' => 'wc_000000000000_999999' ) );

		$this->assertSame( 200, $this->deliver( $event )->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
		$this->assertSame( 0, $this->gets() );
		$this->assertNotEmpty( $logged );
		$this->assertSame( 'unknown_order', $logged[0]['reason'] );
	}

	public function test_an_order_key_mismatch_changes_nothing(): void {
		$order                              = $this->order();
		$view                               = $this->session( $order, 'SETTLED', array( array() ) );
		$view['metadata']['order_key']      = 'wc_order_SomeoneElse';
		$this->sessions[ self::SESSION_ID ] = $view;

		$this->assertSame( 200, $this->deliver( self::event( 'payment.succeeded', $order ) )->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
	}

	public function test_a_session_the_api_does_not_know_is_acknowledged(): void {
		$order = $this->order();

		$this->assertSame( 200, $this->deliver( self::event( 'payment.succeeded', $order ) )->get_status() );
		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
	}

	public function test_an_event_for_an_older_session_of_the_order_still_applies(): void {
		$order = $this->order( array( 'session' => self::SESSION_ID ) );
		$this->session( $order, 'SETTLED', array( array() ), array( 'id' => self::OLD_SESSION_ID ) );

		$response = $this->deliver( self::event( 'payment.succeeded', $order, array( 'session_id' => self::OLD_SESSION_ID ) ) );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	// ---------------------------------------------------------------- §6 rows.

	public function test_payment_succeeded_completes_payment_with_a_full_note(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );

		$this->assertSame( 200, $this->deliver( self::event( 'payment.succeeded', $order ) )->get_status() );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertSame( self::PAYMENT_ID, $order->get_transaction_id() );
		$this->assertNotNull( $order->get_date_paid() );
		$note = implode( "\n", self::notes( $order ) );
		$this->assertStringContainsString( 'Crypto payment received', $note );
		$this->assertStringContainsString( '$49.00', $note );
		$this->assertStringContainsString( 'nep141:wrap.near', $note );
		$this->assertStringContainsString( 'NEAR', $note );
		$this->assertStringContainsString( 'https://testnet.nearblocks.io/txns/' . self::TX_HASH, $note );
		$this->assertStringContainsString( '[Test]', $note );
	}

	public function test_a_virtual_order_is_completed(): void {
		$order = $this->order( array( 'virtual' => true ) );
		$this->session( $order, 'SETTLED', array( array() ) );

		$this->deliver( self::event( 'payment.succeeded', $order ) );

		$this->assertSame( 'completed', self::fresh( $order )->get_status() );
	}

	public function test_the_note_carries_the_fx_line_for_a_converted_order(): void {
		$order = $this->order( array( 'currency' => 'NGN' ) );
		$this->session(
			$order,
			'SETTLED',
			array( array() ),
			array(
				'original_amount'   => '78500.00',
				'original_currency' => 'NGN',
				'fx'                => array(
					'rate'   => '1602.04',
					'source' => 'fixed',
					'as_of'  => '2026-10-26T10:00:00.000Z',
				),
			)
		);

		$this->deliver( self::event( 'payment.succeeded', $order ) );

		$note = implode( "\n", self::notes( self::fresh( $order ) ) );
		$this->assertStringContainsString( 'Converted ₦78,500.00 → $49.00 at 1 USD = 1,602.04 NGN (fixed, 2026-10-26 10:00 UTC)', $note );
	}

	public function test_overpaid_notes_that_the_extra_is_being_returned(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array( 'overpaid_amount' => '5000000000000000000000000' ) ) );

		$this->deliver( self::event( 'payment.succeeded', $order ) );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertStringContainsString( 'paid more than the order total; tendr is returning the extra', implode( "\n", self::notes( $order ) ) );
	}

	public function test_overpaid_under_a_dollar_notes_that_the_extra_was_kept(): void {
		$order = $this->order();
		$this->session(
			$order,
			'SETTLED',
			array(
				array(
					'overpaid_amount'        => '10000000000000000000',
					'kept_small_overpayment' => true,
				),
			)
		);

		$this->deliver( self::event( 'payment.succeeded', $order ) );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertStringContainsString( 'under $1', implode( "\n", self::notes( $order ) ) );
	}

	public function test_underpaid_while_the_shopper_can_still_pay_stays_pending_with_a_note(): void {
		$order = $this->order();
		$this->session(
			$order,
			'PENDING_DEPOSIT',
			array(
				array(
					'status'     => 'REFUNDING',
					'settled_at' => null,
				),
			)
		);

		$this->deliver( self::event( 'payment.refunded', $order, array( 'reason' => 'underpaid' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'pending', $order->get_status() );
		$this->assertStringContainsString( 'Underpaid', implode( "\n", self::notes( $order ) ) );
		$this->assertStringContainsString( 'can still pay', implode( "\n", self::notes( $order ) ) );
	}

	public function test_underpaid_and_refunded_fails_the_order_with_a_note(): void {
		$order = $this->order();
		$this->session(
			$order,
			'REFUNDED',
			array(
				array(
					'status'     => 'REFUNDED',
					'settled_at' => null,
				),
			)
		);

		$this->deliver( self::event( 'payment.refunded', $order, array( 'reason' => 'underpaid' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'failed', $order->get_status() );
		$notes = implode( "\n", self::notes( $order ) );
		$this->assertStringContainsString( 'Underpaid', $notes );
		$this->assertStringContainsString( 'returned', $notes );
		$this->assertStringContainsString( 'try again', $notes );
	}

	public function test_session_expired_without_payment_cancels_and_releases_stock(): void {
		$order      = $this->order( array( 'stock' => true ) );
		$product_id = current( $order->get_items() )->get_product_id();
		$this->assertSame( 8, wc_get_product( $product_id )->get_stock_quantity() );
		$this->session( $order, 'EXPIRED', array() );

		$this->deliver( self::event( 'checkout.session.expired', $order, array( 'reason' => 'timeout' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'cancelled', $order->get_status() );
		$this->assertSame( 10, wc_get_product( $product_id )->get_stock_quantity() );
		$this->assertStringContainsString( 'expired without a payment', implode( "\n", self::notes( $order ) ) );
	}

	public function test_expiry_of_an_older_session_leaves_the_order_alone(): void {
		$order = $this->order( array( 'session' => self::SESSION_ID ) );
		$this->session( $order, 'EXPIRED', array(), array( 'id' => self::OLD_SESSION_ID ) );

		$this->deliver( self::event( 'checkout.session.expired', $order, array( 'session_id' => self::OLD_SESSION_ID ) ) );

		$this->assertSame( 'pending', self::fresh( $order )->get_status() );
	}

	public function test_payment_late_on_a_cancelled_order_adds_a_note_only(): void {
		$order = $this->order();
		$order->update_status( 'cancelled' );
		$this->session(
			$order,
			'LATE_DEPOSIT',
			array(
				array(
					'status'     => 'PROCESSING',
					'is_late'    => true,
					'settled_at' => null,
				),
			)
		);

		$this->deliver( self::event( 'payment.late', $order, array( 'session_status' => 'EXPIRED' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'cancelled', $order->get_status() );
		$this->assertStringContainsString( 'arrived after this checkout expired', implode( "\n", self::notes( $order ) ) );
	}

	public function test_a_late_payment_refunded_keeps_the_order_cancelled_with_a_note(): void {
		$order = $this->order();
		$order->update_status( 'cancelled' );
		$this->session(
			$order,
			'REFUNDED',
			array(
				array(
					'status'     => 'REFUNDED',
					'is_late'    => true,
					'settled_at' => null,
				),
			)
		);

		$this->deliver( self::event( 'payment.refunded', $order, array( 'reason' => 'late' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'cancelled', $order->get_status() );
		$this->assertStringContainsString( 'late payment is being returned', implode( "\n", self::notes( $order ) ) );
	}

	public function test_payment_held_puts_an_unpaid_order_on_hold_with_a_review_link(): void {
		$order = $this->order();
		$this->session(
			$order,
			'HELD',
			array(
				array(
					'status'      => 'HELD',
					'held_reason' => 'sanctions',
					'settled_at'  => null,
				),
			)
		);

		$this->deliver( self::event( 'payment.held', $order, array( 'held_reason' => 'sanctions' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'on-hold', $order->get_status() );
		$notes = implode( "\n", self::notes( $order ) );
		$this->assertStringContainsString( 'on hold for review', $notes );
		$this->assertStringContainsString( Tendr_Plugin::checkout_base() . '/dashboard/review', $notes );
	}

	public function test_held_never_moves_to_processing_even_if_succeeded_arrives_later(): void {
		$order = $this->order();
		$this->session(
			$order,
			'HELD',
			array(
				array(
					'status'      => 'HELD',
					'held_reason' => 'sanctions',
					'settled_at'  => null,
				),
			)
		);
		$this->deliver( self::event( 'payment.held', $order ) );

		// A later payment.succeeded (another payment of the order, or a forged-but-signed stale one).
		$this->session( $order, 'SETTLED', array( array( 'id' => 'pay_01JSECOND000000000000000000' ) ) );
		$this->assertSame( 200, $this->deliver( self::event( 'payment.succeeded', $order, array( 'payment_id' => 'pay_01JSECOND000000000000000000' ) ) )->get_status() );

		$order = self::fresh( $order );
		$this->assertSame( 'on-hold', $order->get_status() );
		$this->assertStringContainsString( 'stays on hold', implode( "\n", self::notes( $order ) ) );
	}

	public function test_payment_held_on_an_already_paid_order_adds_a_note_only(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$this->deliver( self::event( 'payment.succeeded', $order ) );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );

		$this->session( $order, 'SETTLED', array( array( 'held_reason' => 'sanctions' ) ) );
		$this->deliver( self::event( 'payment.held', $order, array( 'refund_id' => 'ref_1' ) ) );

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertStringContainsString( 'review', implode( "\n", self::notes( $order ) ) );
	}

	public function test_payload_says_succeeded_but_the_re_read_says_processing_changes_nothing(): void {
		$order = $this->order();
		$this->session(
			$order,
			'PROCESSING',
			array(
				array(
					'status'     => 'PROCESSING',
					'settled_at' => null,
				),
			)
		);
		$event = self::event( 'payment.succeeded', $order );

		$this->assertSame( 200, $this->deliver( $event )->get_status() );

		$order = self::fresh( $order );
		$this->assertSame( 'pending', $order->get_status() );
		$this->assertSame( '', $order->get_transaction_id() );
	}

	public function test_a_second_settled_payment_on_a_paid_order_is_noted(): void {
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$this->deliver( self::event( 'payment.succeeded', $order ) );

		$this->session( $order, 'SETTLED', array( array( 'id' => 'pay_01JSECOND000000000000000000' ) ), array( 'id' => self::OLD_SESSION_ID ) );
		$this->deliver(
			self::event(
				'payment.succeeded',
				$order,
				array(
					'payment_id' => 'pay_01JSECOND000000000000000000',
					'session_id' => self::OLD_SESSION_ID,
				)
			)
		);

		$order = self::fresh( $order );
		$this->assertSame( 'processing', $order->get_status() );
		$this->assertSame( self::PAYMENT_ID, $order->get_transaction_id() );
		$this->assertStringContainsString( 'Another crypto payment', implode( "\n", self::notes( $order ) ) );
	}

	// ---------------------------------------------------------------- Task 11 hand-off.

	public function test_refund_events_go_to_the_refund_handler_and_are_acknowledged(): void {
		$seen = array();
		add_action(
			'tendr_refund_event',
			static function ( $order, $event ) use ( &$seen ) {
				$seen[] = $event['type'];
			},
			10,
			2
		);
		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$this->deliver( self::event( 'payment.succeeded', $order ) );

		$this->session( $order, 'SETTLED', array( array( 'status' => 'REFUNDED' ) ) );
		foreach ( array( 'refund.pending', 'refund.sent', 'refund.cancelled', 'refund.failed', 'refund.needs_address' ) as $type ) {
			$this->assertSame( 200, $this->deliver( self::event( $type, $order, array( 'refund_id' => 'ref_1' ) ) )->get_status() );
		}
		$this->assertSame( 200, $this->deliver( self::event( 'payment.refunded', $order, array( 'reason' => 'merchant' ) ) )->get_status() );

		$this->assertSame( array( 'refund.pending', 'refund.sent', 'refund.cancelled', 'refund.failed', 'refund.needs_address', 'payment.refunded' ), $seen );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	// ---------------------------------------------------------------- the events table.

	public function test_the_events_table_is_created_lazily_when_missing(): void {
		global $wpdb;
		Tendr_Webhooks::ensure_table();
		$wpdb->query( 'DROP TABLE IF EXISTS ' . Tendr_Webhooks::table() ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.NotPrepared

		$order = $this->order();
		$this->session( $order, 'SETTLED', array( array() ) );
		$this->assertSame( 200, $this->deliver( self::event( 'payment.succeeded', $order ) )->get_status() );
		$this->assertSame( 'processing', self::fresh( $order )->get_status() );
	}

	public function test_prune_removes_events_older_than_30_days(): void {
		global $wpdb;
		Tendr_Webhooks::ensure_table();
		$table = Tendr_Webhooks::table();
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$table,
			array(
				'event_id'    => 'evt_old',
				'received_at' => gmdate( 'Y-m-d H:i:s', time() - 31 * DAY_IN_SECONDS ),
				'state'       => 1,
			)
		);
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$table,
			array(
				'event_id'    => 'evt_new',
				'received_at' => gmdate( 'Y-m-d H:i:s', time() - 29 * DAY_IN_SECONDS ),
				'state'       => 1,
			)
		);

		Tendr_Webhooks::prune();

		$ids = $wpdb->get_col( "SELECT event_id FROM {$table} WHERE event_id IN ('evt_old','evt_new')" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$this->assertSame( array( 'evt_new' ), $ids );
	}

	public function test_activation_creates_the_table_and_schedules_the_daily_prune(): void {
		wp_clear_scheduled_hook( Tendr_Webhooks::PRUNE_HOOK );
		Tendr_Webhooks::activate();
		$this->assertNotFalse( wp_next_scheduled( Tendr_Webhooks::PRUNE_HOOK ) );
		$this->assertSame( 'daily', wp_get_schedule( Tendr_Webhooks::PRUNE_HOOK ) );

		Tendr_Webhooks::deactivate();
		$this->assertFalse( wp_next_scheduled( Tendr_Webhooks::PRUNE_HOOK ) );
	}

	public function test_uninstall_drops_the_events_table(): void {
		global $wpdb;
		Tendr_Webhooks::ensure_table();
		if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
			define( 'WP_UNINSTALL_PLUGIN', plugin_basename( TENDR_PLUGIN_FILE ) );
		}
		include TENDR_PLUGIN_DIR . 'uninstall.php';

		$suppress = $wpdb->suppress_errors();
		$wpdb->query( 'SELECT 1 FROM ' . Tendr_Webhooks::table() . ' LIMIT 1' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.NotPrepared
		$wpdb->suppress_errors( $suppress );
		$this->assertNotSame( '', $wpdb->last_error, 'the table is gone' );
		$this->assertFalse( wp_next_scheduled( Tendr_Webhooks::PRUNE_HOOK ) );
	}
}
