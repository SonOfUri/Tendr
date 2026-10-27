<?php
/**
 * Checkout: availability, sessions (create, reuse, never replace a deposit in flight), errors,
 * the order-pay and thank-you pages, and the hold-stock auto-cancel.
 *
 * @package Tendr
 */

/**
 * Tendr_Gateway checkout.
 */
class CheckoutTest extends Tendr_Test_Case {

	const SESSION_ID   = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
	const SESSION_ID_2 = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ1';

	/**
	 * Sessions the mocked API knows: id => GET view.
	 *
	 * @var array<string, array>
	 */
	private array $sessions = array();

	/**
	 * What `POST /v1/checkout/sessions` answers next (null: create a session).
	 *
	 * @var array|null
	 */
	private ?array $create_reply = null;

	/**
	 * What `POST /v1/checkout/sessions/:id/expire` answers (null: 200 with the view).
	 *
	 * @var array|null
	 */
	private ?array $expire_reply = null;

	/**
	 * Ids handed out by the mocked create, in order.
	 *
	 * @var string[]
	 */
	private array $next_ids = array();

	public function set_up(): void {
		parent::set_up();
		$this->sessions        = array();
		$this->create_reply    = null;
		$this->expire_reply    = null;
		$this->next_ids        = array( self::SESSION_ID, self::SESSION_ID_2 );
		$GLOBALS['wp_scripts'] = null; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited -- a fresh script registry per test.
		update_option( 'woocommerce_hold_stock_minutes', '10' );
		WC()->session = new WC_Session_Handler();
		WC()->session->init();
		wc_clear_notices();
		$this->mock_http( fn( $url, $args ) => $this->api( $url, $args ) );
	}

	public function tear_down(): void {
		wc_clear_notices();
		parent::tear_down();
	}

	/**
	 * The mocked tendr API.
	 *
	 * @param string $url  URL.
	 * @param array  $args Request args.
	 */
	private function api( string $url, array $args ): array {
		$path   = (string) wp_parse_url( $url, PHP_URL_PATH );
		$method = $args['method'];
		if ( 'POST' === $method && '/v1/checkout/sessions' === $path ) {
			if ( null !== $this->create_reply ) {
				return self::response( $this->create_reply[0], $this->create_reply[1] );
			}
			$id                    = array_shift( $this->next_ids );
			$body                  = json_decode( (string) $args['body'], true );
			$this->sessions[ $id ] = array_merge(
				self::view( $id, 'PENDING_DEPOSIT', '+10 minutes' ),
				self::priced( (string) $body['amount'], (string) $body['amount_currency'] )
			);
			return self::response(
				201,
				array(
					'id'            => $id,
					'client_secret' => "{$id}_secret_0123456789abcdef0123456789abcdef",
					'url'           => "https://usetendr.tech/pay/{$id}#cs={$id}_secret_0123456789abcdef0123456789abcdef",
					'expires_at'    => gmdate( 'c', time() + 600 ),
					'status'        => 'PENDING_DEPOSIT',
				)
			);
		}
		if ( preg_match( '#^/v1/checkout/sessions/(ses_[A-Z0-9]+)/expire$#', $path, $m ) && 'POST' === $method ) {
			if ( null !== $this->expire_reply ) {
				return self::response( $this->expire_reply[0], $this->expire_reply[1] );
			}
			$this->sessions[ $m[1] ]['status'] = 'EXPIRED';
			return self::response( 200, $this->sessions[ $m[1] ] );
		}
		if ( preg_match( '#^/v1/checkout/sessions/(ses_[A-Z0-9]+)$#', $path, $m ) && 'GET' === $method ) {
			if ( ! isset( $this->sessions[ $m[1] ] ) ) {
				return self::response( 404, self::error( 'NOT_FOUND', 'Session not found' ) );
			}
			return self::response( 200, $this->sessions[ $m[1] ] );
		}
		return self::response( 500, self::error( 'INTERNAL', 'unexpected ' . $method . ' ' . $path ) );
	}

	/**
	 * A GET session view (the fields the plugin reads).
	 *
	 * @param string $id       Session id.
	 * @param string $status   Session status.
	 * @param string $expires  strtotime() offset.
	 * @param array  $payments Payment statuses.
	 */
	private static function view( string $id, string $status, string $expires, array $payments = array() ): array {
		return array(
			'id'         => $id,
			'livemode'   => false,
			'status'     => $status,
			'amount'     => '49.01',
			'expires_at' => gmdate( 'Y-m-d\TH:i:s.000\Z', strtotime( $expires ) ),
			'url'        => "https://usetendr.tech/pay/{$id}",
			'payments'   => array_map(
				static fn( $s ) => array(
					'id'     => 'pay_1',
					'status' => $s,
				),
				$payments
			),
		);
	}

	/**
	 * The amount fields of a session view created for `$amount` `$currency`: USD as is, any other
	 * currency converted (the order's total in `original_amount`).
	 *
	 * @param string $amount   Amount as sent.
	 * @param string $currency Currency as sent.
	 */
	private static function priced( string $amount, string $currency ): array {
		if ( 'USD' === $currency ) {
			return array(
				'amount'            => $amount,
				'amount_currency'   => 'USD',
				'original_amount'   => null,
				'original_currency' => null,
			);
		}
		return array(
			'amount'            => '49.01',
			'amount_currency'   => 'USD',
			'original_amount'   => $amount . ( str_contains( $amount, '.' ) ? '' : '.00' ),
			'original_currency' => $currency,
		);
	}

	/**
	 * An API error body.
	 *
	 * @param string $code    Code.
	 * @param string $message Message.
	 */
	private static function error( string $code, string $message, ?array $details = null ): array {
		$error = array(
			'code'      => $code,
			'message'   => $message,
			'requestId' => 'req_1',
		);
		if ( null !== $details ) {
			$error['details'] = $details;
		}
		return array( 'error' => $error );
	}

	/**
	 * A pending checkout order paid with tendr.
	 *
	 * @param string $currency Currency.
	 * @param string $total    Total.
	 */
	private static function order( string $currency = 'NGN', string $total = '78500.00' ): WC_Order {
		$order = wc_create_order();
		$order->set_currency( $currency );
		$order->set_total( $total );
		$order->set_billing_email( 'Ada@Example.com' );
		$order->set_payment_method( 'tendr' );
		$order->set_created_via( 'checkout' );
		$order->set_status( 'pending' );
		$order->save();
		return $order;
	}

	/**
	 * The session-create requests made.
	 */
	private function creates(): array {
		return array_values(
			array_filter(
				$this->requests,
				static fn( $r ) => 'POST' === $r['args']['method'] && str_ends_with( (string) wp_parse_url( $r['url'], PHP_URL_PATH ), '/v1/checkout/sessions' )
			)
		);
	}

	/**
	 * The gateway.
	 */
	private static function gateway(): Tendr_Gateway {
		return new Tendr_Gateway();
	}

	// ---------------------------------------------------------------- availability.

	public function test_gateway_hidden_for_guests_in_test_mode_shown_for_admins(): void {
		$this->assertFalse( self::gateway()->is_available(), 'not connected' );

		self::connect_locally();
		$this->assertSame( 'test', Tendr_Connect::mode() );
		$this->assertFalse( self::gateway()->is_available(), 'guest in test mode' );

		$customer = self::factory()->user->create( array( 'role' => 'customer' ) );
		wp_set_current_user( $customer );
		$this->assertFalse( self::gateway()->is_available(), 'customer in test mode' );

		$this->login_admin();
		$this->assertTrue( self::gateway()->is_available(), 'admin in test mode' );
		$this->assertArrayHasKey( 'tendr', WC()->payment_gateways()->get_available_payment_gateways() );

		wp_set_current_user( 0 );
		update_option( 'tendr_mode', 'live' );
		$this->assertTrue( self::gateway()->is_available(), 'guest in live mode' );

		$settings            = get_option( 'woocommerce_tendr_settings' );
		$settings['enabled'] = 'no';
		update_option( 'woocommerce_tendr_settings', $settings );
		$this->assertFalse( self::gateway()->is_available(), 'disabled' );
	}

	// ---------------------------------------------------------------- create.

	public function test_process_payment_sends_exact_body_for_an_ngn_order_and_idempotency_key(): void {
		$issued = self::connect_locally();
		$order  = self::order( 'NGN', '78500.00' );
		$ref    = 'wc_' . substr( sha1( (string) get_option( 'tendr_site_id' ) ), 0, 12 ) . '_' . $order->get_id();
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/', (string) get_option( 'tendr_site_id' ), 'a random site id, stored at Connect' );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame(
			array(
				'result'   => 'success',
				'redirect' => $order->get_checkout_payment_url( true ),
			),
			$result
		);
		$creates = $this->creates();
		$this->assertCount( 1, $creates );
		$this->assertSame( 'https://api.usetendr.tech/v1/checkout/sessions', $creates[0]['url'] );
		$this->assertSame( 'Bearer ' . $issued['test']['secret_key'], $creates[0]['args']['headers']['Authorization'] );
		$this->assertSame( $ref . '-1', $creates[0]['args']['headers']['Idempotency-Key'] );
		$this->assertSame(
			array(
				'amount'          => '78500',
				'amount_currency' => 'NGN',
				'external_ref'    => $ref,
				'success_url'     => self::gateway()->get_return_url( $order ),
				'cancel_url'      => $order->get_checkout_payment_url(),
				'expires_in'      => 600,
				'customer_email'  => 'Ada@Example.com',
				'metadata'        => array(
					'order_number' => (string) $order->get_order_number(),
					'order_key'    => $order->get_order_key(),
					'site_url'     => home_url(),
				),
			),
			json_decode( $creates[0]['args']['body'], true )
		);
		$this->assertSame( $creates[0]['args']['body'], wp_json_encode( json_decode( $creates[0]['args']['body'], true ) ), 'JSON as sent' );

		$order = wc_get_order( $order->get_id() );
		$this->assertSame( self::SESSION_ID, $order->get_meta( '_tendr_session_id' ) );
		$this->assertSame( 'test', $order->get_meta( '_tendr_mode' ) );
		$this->assertSame( '1', (string) $order->get_meta( '_tendr_attempt' ) );
		$this->assertSame( $ref, $order->get_meta( '_tendr_external_ref' ) );
		$this->assertStringStartsWith( 'https://usetendr.tech/pay/' . self::SESSION_ID . '#cs=', $order->get_meta( '_tendr_session_url' ) );
		$this->assertSame( 'pending', $order->get_status() );
	}

	public function test_process_payment_sends_exact_body_for_a_jpy_order(): void {
		self::connect_locally();
		update_option( 'woocommerce_hold_stock_minutes', '120' );
		$order = self::order( 'JPY', '1000' );
		$this->assertSame( '1000.00', $order->get_total(), 'WooCommerce stores the store decimals' );

		self::gateway()->process_payment( $order->get_id() );

		$body = json_decode( $this->creates()[0]['args']['body'], true );
		$this->assertSame( '1000', $body['amount'] );
		$this->assertSame( 'JPY', $body['amount_currency'] );
		$this->assertSame( 1800, $body['expires_in'], '120 minutes clamps to 1800 s' );
	}

	public function test_amount_keeps_significant_decimals_and_expires_in_clamps_low(): void {
		self::connect_locally();
		update_option( 'woocommerce_hold_stock_minutes', '0' );
		$order = self::order( 'KWD', '1.230' );

		self::gateway()->process_payment( $order->get_id() );

		$body = json_decode( $this->creates()[0]['args']['body'], true );
		$this->assertSame( '1.23', $body['amount'] );
		$this->assertSame( 1800, $body['expires_in'], 'hold stock off → the API maximum' );

		$this->assertSame( 60, Tendr_Gateway::expires_in( '1' ) );
		$this->assertSame( 60, Tendr_Gateway::expires_in( '0.5' ) );
		$this->assertSame( 1800, Tendr_Gateway::expires_in( '' ) );
		$this->assertSame( 900, Tendr_Gateway::expires_in( '15' ) );
	}

	public function test_live_mode_uses_the_live_key_and_records_live(): void {
		$issued = self::connect_locally();
		update_option( 'tendr_mode', 'live' );
		$order = self::order();

		self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'Bearer ' . $issued['live']['secret_key'], $this->creates()[0]['args']['headers']['Authorization'] );
		$this->assertSame( 'live', wc_get_order( $order->get_id() )->get_meta( '_tendr_mode' ) );
	}

	// ---------------------------------------------------------------- reuse.

	public function test_second_process_payment_on_same_pending_order_reuses_open_session(): void {
		self::connect_locally();
		$order = self::order();

		$first  = self::gateway()->process_payment( $order->get_id() );
		$second = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( $first, $second );
		$this->assertCount( 1, $this->creates() );
		$order = wc_get_order( $order->get_id() );
		$this->assertSame( self::SESSION_ID, $order->get_meta( '_tendr_session_id' ) );
		$this->assertSame( '1', (string) $order->get_meta( '_tendr_attempt' ) );
	}

	public function test_deposit_in_flight_session_is_never_replaced(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$url = wc_get_order( $order->get_id() )->get_meta( '_tendr_session_url' );

		$cases = array(
			'expired, payment detected'    => self::view( self::SESSION_ID, 'PENDING_DEPOSIT', '-5 minutes', array( 'DETECTED' ) ),
			'session processing'           => self::view( self::SESSION_ID, 'PROCESSING', '-5 minutes', array( 'PROCESSING' ) ),
			'screening'                    => self::view( self::SESSION_ID, 'SCREENING_PENDING', '-5 minutes', array( 'SCREENING_PENDING' ) ),
			'expired session, late in'     => self::view( self::SESSION_ID, 'EXPIRED', '-5 minutes', array( 'DETECTED' ) ),
			'settled (webhook on its way)' => self::view( self::SESSION_ID, 'SETTLED', '-5 minutes', array( 'SETTLED' ) ),
			'held'                         => self::view( self::SESSION_ID, 'HELD', '-5 minutes', array( 'HELD' ) ),
		);
		foreach ( $cases as $label => $view ) {
			$this->sessions[ self::SESSION_ID ] = $view;
			$result                             = self::gateway()->process_payment( $order->get_id() );
			$this->assertSame( 'success', $result['result'], $label );
			$this->assertSame( $order->get_checkout_payment_url( true ), $result['redirect'], $label );
			$this->assertCount( 1, $this->creates(), $label . ': no new session' );
			$this->assertSame( self::SESSION_ID, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ), $label );
			$this->assertSame( $url, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_url' ), $label );
		}
	}

	public function test_api_refusing_a_new_session_for_a_held_ref_shows_the_old_session_again(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		// Past expiry with nothing visible in flight: the plugin tries a new session, and the API
		// refuses because a deposit it can see (unpolled / reported) is in flight.
		$this->sessions[ self::SESSION_ID ] = self::view( self::SESSION_ID, 'PENDING_DEPOSIT', '-1 minute' );
		$this->create_reply                 = array( 409, self::error( 'CONFLICT', 'A deposit for this session is still in progress; retry once it is processed' ) );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$this->assertSame( $order->get_checkout_payment_url( true ), $result['redirect'] );
		$this->assertSame( self::SESSION_ID, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
		$this->assertCount( 0, wc_get_notices( 'error' ) );
	}

	public function test_an_expired_session_is_replaced_with_the_next_idempotency_key(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->sessions[ self::SESSION_ID ] = self::view( self::SESSION_ID, 'EXPIRED', '-1 minute' );

		self::gateway()->process_payment( $order->get_id() );

		$creates = $this->creates();
		$this->assertCount( 2, $creates );
		$ref = wc_get_order( $order->get_id() )->get_meta( '_tendr_external_ref' );
		$this->assertSame( $ref . '-2', $creates[1]['args']['headers']['Idempotency-Key'] );
		$this->assertSame( $ref, json_decode( $creates[1]['args']['body'], true )['external_ref'] );
		$order = wc_get_order( $order->get_id() );
		$this->assertSame( self::SESSION_ID_2, $order->get_meta( '_tendr_session_id' ) );
		$this->assertSame( '2', (string) $order->get_meta( '_tendr_attempt' ) );
	}

	public function test_a_session_the_api_no_longer_knows_is_replaced(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		unset( $this->sessions[ self::SESSION_ID ] );

		self::gateway()->process_payment( $order->get_id() );

		$this->assertCount( 2, $this->creates() );
		$this->assertSame( self::SESSION_ID_2, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
	}

	// ---------------------------------------------------------------- errors.

	public function test_fx_rate_unavailable_shows_a_notice_and_the_order_stays_pending(): void {
		self::connect_locally();
		$order              = self::order();
		$this->create_reply = array( 503, self::error( 'FX_RATE_UNAVAILABLE', 'No current exchange rate for NGN' ) );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'failure', $result['result'] );
		$notices = wc_get_notices( 'error' );
		$this->assertCount( 1, $notices );
		$this->assertStringContainsString( 'Crypto payment is unavailable right now', $notices[0]['notice'] );
		$order = wc_get_order( $order->get_id() );
		$this->assertSame( 'pending', $order->get_status() );
		$this->assertSame( '', $order->get_meta( '_tendr_session_id' ) );

		// A 5xx is never stored by the API's idempotency layer: the retry reuses the same key.
		wc_clear_notices();
		$this->create_reply = null;
		self::gateway()->process_payment( $order->get_id() );
		$creates = $this->creates();
		$this->assertSame( $creates[0]['args']['headers']['Idempotency-Key'], $creates[1]['args']['headers']['Idempotency-Key'] );
		$this->assertSame( self::SESSION_ID, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
	}

	public function test_account_not_ready_shows_the_notice_and_burns_the_key(): void {
		self::connect_locally();
		$order              = self::order();
		$this->create_reply = array( 409, self::error( 'ACCOUNT_NOT_READY', 'The store has no active account in this mode yet' ) );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'failure', $result['result'] );
		$this->assertStringContainsString( 'Crypto payment is unavailable right now', wc_get_notices( 'error' )[0]['notice'] );
		$this->assertStringNotContainsString( 'active account', wc_get_notices( 'error' )[0]['notice'] );
		$this->assertSame( 'pending', wc_get_order( $order->get_id() )->get_status() );

		// A 4xx is stored and would be replayed for 24 h: the next try uses a fresh key.
		$this->create_reply = null;
		self::gateway()->process_payment( $order->get_id() );
		$creates = $this->creates();
		$ref     = Tendr_Gateway::external_ref( $order->get_id() );
		$this->assertSame( $ref . '-1', $creates[0]['args']['headers']['Idempotency-Key'] );
		$this->assertSame( $ref . '-2', $creates[1]['args']['headers']['Idempotency-Key'] );
	}

	public function test_an_idempotency_conflict_retries_once_with_the_next_key(): void {
		self::connect_locally();
		$order = self::order();
		$calls = 0;
		remove_all_filters( 'pre_http_request' );
		$this->mock_http(
			function ( $url, $args ) use ( &$calls ) {
				if ( 'POST' === $args['method'] && 0 === $calls++ ) {
					return self::response( 409, self::error( 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request' ) );
				}
				return $this->api( $url, $args );
			}
		);

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$creates = $this->creates();
		$this->assertCount( 2, $creates );
		$this->assertStringEndsWith( '-2', $creates[1]['args']['headers']['Idempotency-Key'] );
		$this->assertSame( '2', (string) wc_get_order( $order->get_id() )->get_meta( '_tendr_attempt' ) );
	}

	public function test_other_api_errors_show_a_generic_notice_without_api_text(): void {
		self::connect_locally();
		$order              = self::order();
		$this->create_reply = array( 400, self::error( 'VALIDATION_ERROR', 'amount in XYZ allows at most 0 decimal places' ) );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'failure', $result['result'] );
		$notice = wc_get_notices( 'error' )[0]['notice'];
		$this->assertStringContainsString( 'Crypto payment could not be started', $notice );
		$this->assertStringNotContainsString( 'decimal places', $notice );
		$this->assertSame( 'pending', wc_get_order( $order->get_id() )->get_status() );
	}

	// ---------------------------------------------------------------- pages.

	public function test_the_order_pay_page_opens_the_modal_with_the_session_url_only(): void {
		$issued = self::connect_locally();
		$order  = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$session_url = wc_get_order( $order->get_id() )->get_meta( '_tendr_session_url' );

		ob_start();
		do_action( 'woocommerce_receipt_tendr', $order->get_id() );
		$html = (string) ob_get_clean();

		$this->assertTrue( wp_script_is( 'tendr-js', 'enqueued' ) );
		$this->assertSame( 'https://usetendr.tech/v1/tendr.js', wp_scripts()->registered['tendr-js']->src );
		$this->assertTrue( wp_script_is( 'tendr-checkout', 'enqueued' ) );
		$this->assertContains( 'tendr-js', wp_scripts()->registered['tendr-checkout']->deps );
		$data = wp_scripts()->get_data( 'tendr-checkout', 'before' );
		$data = is_array( $data ) ? implode( "\n", $data ) : (string) $data;
		$this->assertStringContainsString( wp_json_encode( $session_url ), $data );
		$this->assertStringContainsString( wp_json_encode( self::gateway()->get_return_url( $order ) ), $data );
		// The no-JS fallback: a plain link to the hosted checkout.
		$this->assertStringContainsString( 'href="' . esc_url( $session_url ) . '"', $html );
		foreach ( self::secrets_of( $issued ) as $secret ) {
			$this->assertStringNotContainsString( $secret, $html . $data );
		}
		$this->assertStringNotContainsString( 'tdr_test_', $html . $data );
		$this->assertStringNotContainsString( 'whsec_', $html . $data );
	}

	public function test_the_thank_you_page_waits_for_confirmation_while_pending(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );

		ob_start();
		do_action( 'woocommerce_thankyou_tendr', $order->get_id() );
		$html = (string) ob_get_clean();

		$this->assertStringContainsString( 'Waiting for payment confirmation…', $html );
		$this->assertTrue( wp_script_is( 'tendr-checkout', 'enqueued' ) );
		$data = wp_scripts()->get_data( 'tendr-checkout', 'before' );
		$data = is_array( $data ) ? implode( "\n", $data ) : (string) $data;
		$this->assertStringContainsString( wp_json_encode( rest_url( 'tendr/v1/order-status/' . $order->get_order_key() ) ), $data );
		$this->assertStringContainsString( '"interval":3000', $data );
		$this->assertStringNotContainsString( '#cs=', $data, 'the thank-you page needs no session secret' );

		wp_dequeue_script( 'tendr-checkout' );
		$order->update_status( 'processing' );
		ob_start();
		do_action( 'woocommerce_thankyou_tendr', $order->get_id() );
		$this->assertStringNotContainsString( 'Waiting for payment confirmation', (string) ob_get_clean() );
	}

	// ---------------------------------------------------------------- hold-stock auto-cancel.

	public function test_auto_cancel_with_deposit_in_flight_is_reverted_and_stock_kept(): void {
		update_option( 'woocommerce_manage_stock', 'yes' );
		self::connect_locally();
		$product = new WC_Product_Simple();
		$product->set_regular_price( '10' );
		$product->set_manage_stock( true );
		$product->set_stock_quantity( 10 );
		$product->save();

		$order = self::order();
		$order->add_product( $product, 2 );
		$order->save();
		wc_reduce_stock_levels( $order->get_id() );
		$this->assertSame( 8, wc_get_product( $product->get_id() )->get_stock_quantity() );
		self::gateway()->process_payment( $order->get_id() );

		$this->expire_reply = array(
			409,
			self::error( 'DEPOSIT_IN_PROGRESS', 'A deposit for this session is still in progress; retry once it is processed' ),
		);
		// What wc_cancel_unpaid_orders() does for each unpaid checkout order.
		$order = wc_get_order( $order->get_id() );
		if ( apply_filters( 'woocommerce_cancel_unpaid_order', true, $order ) ) {
			$order->update_status( 'cancelled', 'Unpaid order cancelled - time limit reached.' );
		}

		$expire = array_values( array_filter( $this->requests, static fn( $r ) => str_ends_with( $r['url'], '/v1/checkout/sessions/' . self::SESSION_ID . '/expire' ) ) );
		$this->assertCount( 1, $expire );
		$this->assertSame( 'POST', $expire[0]['args']['method'] );
		$order = wc_get_order( $order->get_id() );
		$this->assertSame( 'pending', $order->get_status() );
		$this->assertSame( 8, wc_get_product( $product->get_id() )->get_stock_quantity() );
		$notes = wc_get_order_notes( array( 'order_id' => $order->get_id() ) );
		$this->assertStringContainsString( 'deposit is in progress', $notes[0]->content );
	}

	public function test_auto_cancel_expires_the_session_and_lets_the_cancel_through(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );

		$this->assertTrue( apply_filters( 'woocommerce_cancel_unpaid_order', true, wc_get_order( $order->get_id() ) ) );
		$this->assertSame( 'EXPIRED', $this->sessions[ self::SESSION_ID ]['status'] );
	}

	public function test_auto_cancel_keeps_the_order_when_tendr_cannot_be_reached(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->expire_reply = array( 502, null );

		$this->assertFalse( apply_filters( 'woocommerce_cancel_unpaid_order', true, wc_get_order( $order->get_id() ) ) );
	}

	/**
	 * The order's notes, newest first.
	 *
	 * @param int $order_id Order id.
	 * @return string[]
	 */
	private static function notes( int $order_id ): array {
		return array_map( static fn( $n ) => (string) $n->content, wc_get_order_notes( array( 'order_id' => $order_id ) ) );
	}

	/**
	 * Notes containing a phrase.
	 *
	 * @param int    $order_id Order id.
	 * @param string $phrase   Phrase.
	 */
	private static function notes_with( int $order_id, string $phrase ): int {
		return count( array_filter( self::notes( $order_id ), static fn( $n ) => str_contains( $n, $phrase ) ) );
	}

	/**
	 * Run the cancel filter as wc_cancel_unpaid_orders() does.
	 *
	 * @param int $order_id Order id.
	 */
	private static function cancel_run( int $order_id ): bool {
		return (bool) apply_filters( 'woocommerce_cancel_unpaid_order', true, wc_get_order( $order_id ) );
	}

	public function test_auto_cancel_proceeds_when_the_site_is_no_longer_connected(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		Tendr_Connect::disconnect();
		$this->requests = array();

		$this->assertTrue( self::cancel_run( $order->get_id() ) );
		$this->assertCount( 0, $this->requests, 'no API call without credentials' );
	}

	public function test_auto_cancel_proceeds_on_permanent_api_errors(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$cases = array(
			401 => self::error( 'UNAUTHORIZED', 'Invalid API key' ),
			403 => self::error( 'FORBIDDEN', 'Key lacks scope' ),
			400 => self::error( 'VALIDATION_ERROR', 'Request validation failed' ),
		);
		foreach ( $cases as $status => $body ) {
			$this->expire_reply = array( $status, $body );
			$this->assertTrue( self::cancel_run( $order->get_id() ), "HTTP $status cancels" );
		}
	}

	public function test_auto_cancel_keeps_the_order_on_temporary_failures(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );

		$this->expire_reply = array( 429, self::error( 'RATE_LIMITED', 'Too many requests' ) );
		$this->assertFalse( self::cancel_run( $order->get_id() ), '429' );
		$this->expire_reply = array( 503, self::error( 'INTERNAL', 'down' ) );
		$this->assertFalse( self::cancel_run( $order->get_id() ), '503' );
		$this->expire_reply = array( 404, null );
		$this->assertFalse( self::cancel_run( $order->get_id() ), 'a 404 that is not the API (proxy, wrong base)' );

		remove_all_filters( 'pre_http_request' );
		add_filter( 'pre_http_request', static fn() => new WP_Error( 'http_request_failed', 'cURL error 28' ) );
		$this->assertFalse( self::cancel_run( $order->get_id() ), 'transport failure' );
	}

	public function test_auto_cancel_writes_each_hold_note_once(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );

		$this->expire_reply = array( 502, null );
		self::cancel_run( $order->get_id() );
		self::cancel_run( $order->get_id() );
		$this->assertSame( 1, self::notes_with( $order->get_id(), 'could not be reached' ) );

		$this->expire_reply = array( 409, self::error( 'DEPOSIT_IN_PROGRESS', 'in progress' ) );
		self::cancel_run( $order->get_id() );
		self::cancel_run( $order->get_id() );
		$this->assertSame( 1, self::notes_with( $order->get_id(), 'deposit is in progress' ) );
		$this->assertSame( 1, self::notes_with( $order->get_id(), 'could not be reached' ) );
	}

	public function test_auto_cancel_proceeds_when_the_session_is_gone_or_already_expired(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );

		$this->expire_reply = array( 404, self::error( 'NOT_FOUND', 'Session not found' ) );
		$this->assertTrue( self::cancel_run( $order->get_id() ), 'unknown to the API' );

		$this->expire_reply                 = array( 409, self::error( 'INVALID_STATE_TRANSITION', 'EXPIRED → EXPIRED' ) );
		$this->sessions[ self::SESSION_ID ] = self::view( self::SESSION_ID, 'EXPIRED', '-1 minute' );
		$this->assertTrue( self::cancel_run( $order->get_id() ), 'already expired' );

		$this->sessions[ self::SESSION_ID ] = self::view( self::SESSION_ID, 'SETTLED', '-1 minute', array( 'SETTLED' ) );
		$this->assertFalse( self::cancel_run( $order->get_id() ), 'paid: the webhook moves the order' );
	}

	public function test_auto_cancel_keeps_an_order_whose_session_belongs_to_an_earlier_connection(): void {
		self::connect_locally( 'a' );
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->assertSame( Tendr_Connect::connection()['id'], wc_get_order( $order->get_id() )->get_meta( '_tendr_connection_id' ) );

		Tendr_Connect::disconnect();
		self::connect_locally( 'b' );
		$this->expire_reply = array( 404, self::error( 'NOT_FOUND', 'Session not found' ) );

		$this->assertFalse( self::cancel_run( $order->get_id() ) );
		$this->assertFalse( self::cancel_run( $order->get_id() ) );
		$this->assertSame( 1, self::notes_with( $order->get_id(), 'belongs to an earlier connection' ) );
	}

	public function test_auto_cancel_still_cancels_a_not_found_session_of_the_same_connection_or_a_legacy_order(): void {
		self::connect_locally( 'a' );
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->expire_reply = array( 404, self::error( 'NOT_FOUND', 'Session not found' ) );
		$this->assertTrue( self::cancel_run( $order->get_id() ), 'same connection' );

		$legacy = wc_get_order( $order->get_id() );
		$legacy->delete_meta_data( '_tendr_connection_id' );
		$legacy->save();
		Tendr_Connect::disconnect();
		self::connect_locally( 'b' );
		$this->assertTrue( self::cancel_run( $order->get_id() ), 'legacy order without a stored connection' );
	}

	public function test_a_404_that_is_not_the_api_never_replaces_the_session(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		remove_all_filters( 'pre_http_request' );
		$this->mock_http(
			function ( $url, $args ) {
				if ( 'GET' === $args['method'] ) {
					$r         = self::response( 404 );
					$r['body'] = '<html>Not Found</html>';
					return $r;
				}
				return $this->api( $url, $args );
			}
		);

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'failure', $result['result'] );
		$this->assertCount( 1, $this->creates() );
		$this->assertSame( self::SESSION_ID, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
	}

	public function test_an_unknown_session_status_shows_the_stored_session_again(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->sessions[ self::SESSION_ID ] = self::view( self::SESSION_ID, 'SOMETHING_NEW', '-5 minutes' );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$this->assertCount( 1, $this->creates() );
		$this->assertSame( 'in_flight', Tendr_Gateway::disposition( self::view( 'ses_X', 'SOMETHING_NEW', '+5 minutes' ) ) );
		$this->assertSame( 'in_flight', Tendr_Gateway::disposition( array( 'status' => 'PENDING_DEPOSIT' ) ), 'no expiry: do not guess' );
		$this->assertSame( 'dead', Tendr_Gateway::disposition( self::view( 'ses_X', 'REFUNDED', '-5 minutes' ) ) );
	}

	public function test_too_many_decimals_for_the_currency_gets_a_specific_notice(): void {
		self::connect_locally();
		$order              = self::order( 'JPY', '1000.50' );
		$this->create_reply = array(
			400,
			self::error( 'VALIDATION_ERROR', 'amount in JPY allows at most 0 decimal places', array( 'field' => 'amount' ) ),
		);

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'failure', $result['result'] );
		$notice = wc_get_notices( 'error' )[0]['notice'];
		$this->assertStringContainsString( 'decimals', $notice );
		$this->assertStringContainsString( 'JPY', $notice );
		$this->assertStringNotContainsString( 'Please try again', $notice );
		$this->assertSame( 'pending', wc_get_order( $order->get_id() )->get_status() );
	}

	public function test_the_thank_you_page_has_a_message_for_when_polling_stops(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );

		ob_start();
		do_action( 'woocommerce_thankyou_tendr', $order->get_id() );
		ob_end_clean();

		$data = wp_scripts()->get_data( 'tendr-checkout', 'before' );
		$data = is_array( $data ) ? implode( "\n", $data ) : (string) $data;
		$this->assertStringContainsString( '"stopAfter":3600000', $data );
		$this->assertStringContainsString( 'taking longer than usual', $data );
		$this->assertStringContainsString( 'email', $data );
	}

	public function test_the_session_url_is_cleared_once_the_order_leaves_pending(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->assertNotSame( '', wc_get_order( $order->get_id() )->get_meta( '_tendr_session_url' ) );

		wc_get_order( $order->get_id() )->update_status( 'processing' );

		$order = wc_get_order( $order->get_id() );
		$this->assertSame( '', $order->get_meta( '_tendr_session_url' ) );
		$this->assertSame( self::SESSION_ID, $order->get_meta( '_tendr_session_id' ), 'the id stays for webhooks and refunds' );

		$other = self::order();
		$other->set_payment_method( 'bacs' );
		$other->update_meta_data( '_tendr_session_url', 'keep' );
		$other->save();
		$other->update_status( 'processing' );
		$this->assertSame( 'keep', wc_get_order( $other->get_id() )->get_meta( '_tendr_session_url' ) );
	}

	public function test_a_failed_order_paid_again_gets_a_new_session(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$this->sessions[ self::SESSION_ID ] = self::view( self::SESSION_ID, 'REFUNDED', '-5 minutes', array( 'REFUNDED' ) );
		wc_get_order( $order->get_id() )->update_status( 'failed' );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$this->assertSame( self::SESSION_ID_2, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
		$this->assertNotSame( '', wc_get_order( $order->get_id() )->get_meta( '_tendr_session_url' ) );
	}

	public function test_auto_cancel_leaves_other_orders_alone(): void {
		self::connect_locally();
		$order = self::order();
		$order->set_payment_method( 'bacs' );
		$order->save();

		$this->assertTrue( apply_filters( 'woocommerce_cancel_unpaid_order', true, $order ) );
		$this->assertFalse( apply_filters( 'woocommerce_cancel_unpaid_order', false, $order ) );
		$this->assertCount( 0, $this->requests );
	}

	// ---------------------------------------------------------------- lookup for webhooks.

	public function test_order_from_external_ref(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$ref = Tendr_Gateway::external_ref( $order->get_id() );

		$this->assertSame( $order->get_id(), Tendr_Gateway::order_from_external_ref( $ref )->get_id() );
		$this->assertNull( Tendr_Gateway::order_from_external_ref( 'wc_000000000000_' . $order->get_id() ), 'another site' );
		$this->assertNull( Tendr_Gateway::order_from_external_ref( $ref . '9' ), 'no such order' );
		$this->assertNull( Tendr_Gateway::order_from_external_ref( 'nonsense' ) );
	}

	// ---------------------------------------------------------------- A1: the total changed.

	public function test_an_open_session_for_another_total_is_cancelled_and_replaced(): void {
		self::connect_locally();
		$order = self::order( 'NGN', '78500.00' );
		self::gateway()->process_payment( $order->get_id() );
		// The merchant edits the pending order (an invoice order) after the shopper opened it.
		$order = wc_get_order( $order->get_id() );
		$order->set_total( '80000.00' );
		$order->save();

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$expires = array_values( array_filter( $this->requests, static fn( $r ) => str_ends_with( (string) wp_parse_url( $r['url'], PHP_URL_PATH ), '/' . self::SESSION_ID . '/expire' ) ) );
		$this->assertCount( 1, $expires, 'the old session is cancelled first' );
		$creates = $this->creates();
		$this->assertCount( 2, $creates );
		$this->assertSame( '80000', json_decode( $creates[1]['args']['body'], true )['amount'] );
		$this->assertSame( self::SESSION_ID_2, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
	}

	public function test_an_open_session_for_the_same_total_in_other_decimals_is_reused(): void {
		self::connect_locally();
		$order = self::order( 'USD', '49.00' );
		self::gateway()->process_payment( $order->get_id() );
		$this->sessions[ self::SESSION_ID ]['amount'] = '49.00';

		self::gateway()->process_payment( $order->get_id() );

		$this->assertCount( 1, $this->creates() );
	}

	public function test_another_total_with_a_deposit_in_flight_shows_the_stored_session(): void {
		self::connect_locally();
		$order = self::order( 'NGN', '78500.00' );
		self::gateway()->process_payment( $order->get_id() );
		$order = wc_get_order( $order->get_id() );
		$order->set_total( '80000.00' );
		$order->save();
		$this->expire_reply = array( 409, self::error( 'DEPOSIT_IN_PROGRESS', 'A deposit for this session is still in progress', array( 'reason' => 'deposit_in_progress' ) ) );

		$result = self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$this->assertCount( 1, $this->creates(), 'no new session while money is on its way' );
		$this->assertSame( self::SESSION_ID, wc_get_order( $order->get_id() )->get_meta( '_tendr_session_id' ) );
	}

	// ---------------------------------------------------------------- A2: the site address changed.

	public function test_order_refs_do_not_depend_on_the_site_address(): void {
		self::connect_locally();
		$order = self::order();
		self::gateway()->process_payment( $order->get_id() );
		$ref = wc_get_order( $order->get_id() )->get_meta( '_tendr_external_ref' );

		$moved = static fn() => 'https://moved.example.org';
		add_filter( 'home_url', $moved );
		try {
			$this->assertSame( $ref, Tendr_Gateway::external_ref( $order->get_id() ), 'new refs ignore the address' );
			$this->assertSame( $order->get_id(), Tendr_Gateway::order_from_external_ref( $ref )->get_id() );
		} finally {
			remove_filter( 'home_url', $moved );
		}
	}

	public function test_an_order_keeps_its_stored_ref_and_an_older_ref_still_resolves(): void {
		self::connect_locally();
		$order  = self::order();
		$legacy = 'wc_' . substr( sha1( 'http://old.example.org' ), 0, 12 ) . '_' . $order->get_id();
		$order->update_meta_data( '_tendr_external_ref', $legacy );
		$order->save();

		self::gateway()->process_payment( $order->get_id() );

		$this->assertSame( $legacy, json_decode( $this->creates()[0]['args']['body'], true )['external_ref'], 'a new session keeps the order ref' );
		$this->assertSame( $order->get_id(), Tendr_Gateway::order_from_external_ref( $legacy )->get_id() );
		$this->assertNull( Tendr_Gateway::order_from_external_ref( Tendr_Gateway::external_ref( $order->get_id() ) ), 'only the stored ref names it' );
	}

	public function test_the_site_id_is_made_once(): void {
		self::connect_locally();
		$id = (string) get_option( 'tendr_site_id' );
		self::connect_locally( 'b' );
		$this->assertSame( $id, (string) get_option( 'tendr_site_id' ) );
	}
}
