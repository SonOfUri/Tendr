<?php
/**
 * The tendr API client.
 *
 * @package Tendr
 */

/**
 * Tendr_Api_Client.
 */
class ApiClientTest extends Tendr_Test_Case {

	/**
	 * Entries passed to the `tendr_api_log` action.
	 *
	 * @var array<int, array>
	 */
	private array $logged = array();

	public function set_up(): void {
		parent::set_up();
		$this->logged = array();
		add_action(
			'tendr_api_log',
			function ( array $entry ) {
				$this->logged[] = $entry;
			}
		);
	}

	public function tear_down(): void {
		remove_all_actions( 'tendr_api_log' );
		parent::tear_down();
	}

	public function test_request_sends_bearer_json_timeout_tls_and_user_agent(): void {
		$issued = self::connect_locally();
		$this->mock_http( static fn() => self::response( 200, array( 'id' => 'cs_1' ) ) );

		$out = Tendr_Api_Client::request( 'POST', '/v1/checkout/sessions', array( 'amount' => '1.00' ), 'test', array( 'Idempotency-Key' => 'order-7' ) );

		$this->assertSame( array( 'id' => 'cs_1' ), $out );
		$this->assertCount( 1, $this->requests );
		$req = $this->requests[0];
		$this->assertSame( 'https://api.usetendr.tech/v1/checkout/sessions', $req['url'] );
		$this->assertSame( 'POST', $req['args']['method'] );
		$this->assertSame( 15, $req['args']['timeout'] );
		$this->assertTrue( $req['args']['sslverify'] );
		$this->assertSame( 'Bearer ' . $issued['test']['secret_key'], $req['args']['headers']['Authorization'] );
		$this->assertSame( 'application/json', $req['args']['headers']['Content-Type'] );
		$this->assertSame( 'order-7', $req['args']['headers']['Idempotency-Key'] );
		$this->assertSame( array( 'amount' => '1.00' ), json_decode( $req['args']['body'], true ) );
		$this->assertMatchesRegularExpression(
			'#^tendr-woocommerce/' . preg_quote( TENDR_VERSION, '#' ) . ' WordPress/[0-9][^ ]* WooCommerce/[0-9][^ ]*$#',
			$req['args']['headers']['User-Agent']
		);
	}

	public function test_live_mode_uses_the_live_key(): void {
		$issued = self::connect_locally();
		$this->mock_http( static fn() => self::response( 200, array() ) );
		Tendr_Api_Client::request( 'GET', '/v1/connect/status', array(), 'live' );
		$this->assertSame( 'Bearer ' . $issued['live']['secret_key'], $this->requests[0]['args']['headers']['Authorization'] );
		$this->assertSame( 'GET', $this->requests[0]['args']['method'] );
	}

	public function test_a_204_returns_an_empty_array(): void {
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 204 ) );
		$this->assertSame( array(), Tendr_Api_Client::request( 'POST', '/v1/connect/disconnect' ) );
	}

	public function test_api_error_json_maps_to_wp_error(): void {
		self::connect_locally();
		$this->mock_http(
			static fn() => self::response(
				409,
				array(
					'error' => array(
						'code'      => 'IDEMPOTENCY_CONFLICT',
						'message'   => 'Key reused with a different body',
						'requestId' => 'req_9',
					),
				)
			)
		);

		$out = Tendr_Api_Client::request( 'POST', '/v1/checkout/sessions', array( 'a' => 1 ) );

		$this->assertWPError( $out );
		$this->assertSame( 'IDEMPOTENCY_CONFLICT', $out->get_error_code() );
		$this->assertSame( 'Key reused with a different body', $out->get_error_message() );
		$this->assertSame( 409, $out->get_error_data()['status'] );
		$this->assertSame( 'req_9', $out->get_error_data()['request_id'] );
	}

	public function test_a_non_json_error_maps_to_a_generic_wp_error(): void {
		self::connect_locally();
		$this->mock_http(
			static function () {
				$r         = self::response( 502 );
				$r['body'] = '<html>Bad gateway</html>';
				return $r;
			}
		);
		$out = Tendr_Api_Client::request( 'GET', '/v1/connect/status' );
		$this->assertWPError( $out );
		$this->assertSame( 'tendr_http_502', $out->get_error_code() );
		$this->assertStringNotContainsString( '<html>', $out->get_error_message() );
	}

	public function test_not_connected_returns_wp_error_without_a_request(): void {
		$this->mock_http( static fn() => self::response( 200, array() ) );
		$out = Tendr_Api_Client::request( 'GET', '/v1/connect/status' );
		$this->assertWPError( $out );
		$this->assertSame( 'tendr_not_connected', $out->get_error_code() );
		$this->assertCount( 0, $this->requests );
	}

	public function test_public_request_sends_no_authorization(): void {
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 200, array( 'ok' => true ) ) );
		Tendr_Api_Client::request_public( 'POST', '/v1/connect/token', array( 'code' => 'c' ) );
		$this->assertArrayNotHasKey( 'Authorization', $this->requests[0]['args']['headers'] );
	}

	public function test_errors_are_logged_with_authorization_and_secrets_redacted(): void {
		$issued = self::connect_locally();
		$secret = $issued['test']['secret_key'];
		// A transport error whose message echoes the secret (as a misbehaving proxy might).
		$this->mock_http( static fn() => new WP_Error( 'http_request_failed', "cURL error 7: proxy said Authorization: Bearer {$secret}" ) );

		$out = Tendr_Api_Client::request( 'POST', '/v1/checkout/sessions', array( 'a' => 1 ) );

		$this->assertWPError( $out );
		$this->assertSame( 'tendr_unreachable', $out->get_error_code() );
		$this->assertStringNotContainsString( $secret, $out->get_error_message() );
		$this->assertCount( 1, $this->logged );
		$dump = (string) wp_json_encode( $this->logged );
		foreach ( self::secrets_of( $issued ) as $s ) {
			$this->assertStringNotContainsString( $s, $dump );
		}
		$this->assertStringNotContainsString( 'tdr_test_', $dump );
		$this->assertSame( '[redacted]', $this->logged[0]['headers']['Authorization'] );
		$this->assertSame( 'POST', $this->logged[0]['method'] );
		$this->assertSame( '/v1/checkout/sessions', $this->logged[0]['path'] );
	}

	public function test_api_errors_are_logged_redacted(): void {
		$issued = self::connect_locally();
		$this->mock_http(
			static fn() => self::response(
				401,
				array(
					'error' => array(
						'code'    => 'UNAUTHORIZED',
						'message' => 'Invalid key ' . $issued['test']['secret_key'],
					),
				)
			)
		);

		$out = Tendr_Api_Client::request( 'GET', '/v1/connect/status' );

		$this->assertWPError( $out );
		$this->assertStringNotContainsString( $issued['test']['secret_key'], $out->get_error_message() );
		$dump = (string) wp_json_encode( $this->logged );
		$this->assertStringNotContainsString( $issued['test']['secret_key'], $dump );
		$this->assertSame( '[redacted]', $this->logged[0]['headers']['Authorization'] );
	}
}
