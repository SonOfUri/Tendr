<?php
/**
 * One-click Connect: start, callback, disconnect.
 *
 * @package Tendr
 */

/**
 * Tendr_Connect.
 */
class ConnectTest extends Tendr_Test_Case {

	/**
	 * Start Connect as the current user and return the popup URL's query.
	 */
	private function start_query(): array {
		$url = Tendr_Connect::start();
		$this->assertIsString( $url );
		return self::query_of( $url );
	}

	/**
	 * The transient Connect saved for a state.
	 *
	 * @param string $state The state.
	 * @return mixed
	 */
	private static function pending( string $state ) {
		return get_transient( Tendr_Connect::transient_key( $state ) );
	}

	/**
	 * Mock `/v1/connect/token` answering with `$issued`.
	 *
	 * @param array $issued A token response.
	 */
	private function mock_token( array $issued ): void {
		$this->mock_http(
			static function ( $url ) use ( $issued ) {
				if ( str_ends_with( $url, '/v1/connect/token' ) ) {
					return self::response( 200, $issued );
				}
				return self::response(
					404,
					array(
						'error' => array(
							'code'    => 'NOT_FOUND',
							'message' => 'Not found',
						),
					)
				);
			}
		);
	}

	public function test_start_builds_the_popup_url(): void {
		$this->login_admin();
		$url = Tendr_Connect::start();
		$this->assertIsString( $url );
		$this->assertStringStartsWith( 'https://usetendr.tech/connect?', $url );

		$q = self::query_of( $url );
		$this->assertSame( home_url(), $q['site_url'] );
		$this->assertSame( admin_url( 'admin.php?page=tendr-connect-callback' ), $q['return_url'] );
		$this->assertStringNotContainsString( '#', $q['return_url'] );
		$this->assertSame( 'S256', $q['code_challenge_method'] );
		$this->assertSame( 'woocommerce', $q['platform'] );
		$this->assertSame( TENDR_VERSION, $q['plugin_version'] );

		// State: 32 random bytes, base64url. Challenge: S256 of the stored 64-byte verifier.
		$this->assertMatchesRegularExpression( '/^[A-Za-z0-9_-]{43}$/', $q['state'] );
		$pending = self::pending( $q['state'] );
		$this->assertIsArray( $pending );
		$this->assertMatchesRegularExpression( '/^[A-Za-z0-9_-]{86}$/', $pending['verifier'] );
		$expected = rtrim( strtr( base64_encode( hash( 'sha256', $pending['verifier'], true ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$this->assertSame( $expected, $q['code_challenge'] );
		$this->assertSame( 43, strlen( $q['code_challenge'] ) );
	}

	public function test_each_start_has_a_new_state_and_verifier(): void {
		$this->login_admin();
		$a = $this->start_query();
		$b = $this->start_query();
		$this->assertNotSame( $a['state'], $b['state'] );
		$this->assertNotSame( $a['code_challenge'], $b['code_challenge'] );
	}

	public function test_state_and_verifier_are_kept_for_60_minutes(): void {
		$this->login_admin();
		$q       = $this->start_query();
		$timeout = (int) get_option( '_transient_timeout_' . Tendr_Connect::transient_key( $q['state'] ) );
		$this->assertEqualsWithDelta( time() + 60 * MINUTE_IN_SECONDS, $timeout, 5 );
	}

	public function test_checkout_base_is_the_connect_host(): void {
		$this->login_admin();
		$this->assertSame( 'https://usetendr.tech', Tendr_Plugin::checkout_base() );
		$this->assertSame( 'https://api.usetendr.tech', Tendr_Plugin::api_base() );
	}

	public function test_site_url_sent_is_home_url_including_subdirectory(): void {
		// wp-env pins WP_HOME, so move the home URL into a subdirectory with the filter instead.
		$root = untrailingslashit( home_url() );
		add_filter( 'home_url', static fn( $url ) => preg_replace( '#^' . preg_quote( $root, '#' ) . '#', $root . '/shop', $url ) );
		$this->login_admin();
		$q = $this->start_query();
		$this->assertSame( $root . '/shop', $q['site_url'] );
		$this->assertSame( home_url(), $q['site_url'] );
		$this->assertSame( $root . '/shop/wp-json/tendr/v1/webhook', untrailingslashit( rest_url( 'tendr/v1/webhook' ) ) );

		$issued = self::issued();
		$this->mock_token( $issued );
		Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);
		$body = json_decode( $this->requests[0]['args']['body'], true );
		$this->assertSame( $root . '/shop', $body['site_url'] );
		remove_all_filters( 'home_url' );
	}

	public function test_start_is_blocked_without_pretty_permalinks(): void {
		$this->set_permalink_structure( '' );
		$this->login_admin();
		$out = Tendr_Connect::start();
		$this->assertWPError( $out );
		$this->assertSame( 'tendr_permalinks', $out->get_error_code() );
		$this->assertStringContainsString( 'Enable pretty permalinks to connect', $out->get_error_message() );
	}

	public function test_start_is_blocked_when_the_rest_prefix_is_not_wp_json(): void {
		add_filter( 'rest_url_prefix', static fn() => 'api' );
		$this->login_admin();
		$out = Tendr_Connect::start();
		remove_all_filters( 'rest_url_prefix' );
		$this->assertWPError( $out );
		$this->assertSame( 'tendr_rest_prefix', $out->get_error_code() );
	}

	public function test_start_is_blocked_when_admin_is_on_another_origin(): void {
		$root = untrailingslashit( site_url() );
		add_filter( 'admin_url', static fn( $url ) => str_replace( $root, 'https://admin.example.org', $url ) );
		$this->login_admin();
		$out = Tendr_Connect::start();
		remove_all_filters( 'admin_url' );
		$this->assertWPError( $out );
		$this->assertSame( 'tendr_admin_origin', $out->get_error_code() );
	}

	public function test_start_requires_manage_woocommerce(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );
		$out = Tendr_Connect::start();
		$this->assertWPError( $out );
		$this->assertSame( 'tendr_forbidden', $out->get_error_code() );
	}

	public function test_callback_rejects_bad_state(): void {
		$this->login_admin();
		$this->start_query();
		$this->mock_token( self::issued() );

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => 'not-the-state',
				'code'  => 'code_1',
			)
		);

		$this->assertSame( 'error', $out['status'] );
		$this->assertCount( 0, $this->requests );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
	}

	public function test_callback_rejects_missing_state(): void {
		$this->login_admin();
		$this->mock_token( self::issued() );
		$out = Tendr_Connect::handle_callback( array( 'code' => 'code_1' ) );
		$this->assertSame( 'error', $out['status'] );
		$this->assertCount( 0, $this->requests );
	}

	public function test_callback_rejects_user_without_manage_woocommerce(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_token( self::issued() );

		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );
		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);

		$this->assertSame( 'error', $out['status'] );
		$this->assertCount( 0, $this->requests );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
	}

	public function test_callback_rejects_a_state_started_by_another_admin(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_token( self::issued() );

		$this->login_admin();
		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);
		$this->assertSame( 'error', $out['status'] );
		$this->assertCount( 0, $this->requests );
	}

	public function test_callback_stores_credentials_and_sets_mode_test_on_success(): void {
		$this->login_admin();
		$q       = $this->start_query();
		$pending = self::pending( $q['state'] );
		$issued  = self::issued();
		$this->mock_token( $issued );

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);

		$this->assertSame( 'connected', $out['status'] );
		$this->assertStringContainsString( 'Corner Shop a', $out['message'] );

		// The exchange: server to server, unauthenticated, with the verifier and the same site_url.
		$this->assertCount( 1, $this->requests );
		$req = $this->requests[0];
		$this->assertSame( 'https://api.usetendr.tech/v1/connect/token', $req['url'] );
		$this->assertSame( 'POST', $req['args']['method'] );
		$this->assertArrayNotHasKey( 'Authorization', $req['args']['headers'] );
		$this->assertSame(
			array(
				'code'          => 'code_1',
				'code_verifier' => $pending['verifier'],
				'site_url'      => home_url(),
			),
			json_decode( $req['args']['body'], true )
		);

		$this->assertSame( $issued['test'], Tendr_Credentials::get( 'test' ) );
		$this->assertSame( $issued['live'], Tendr_Credentials::get( 'live' ) );
		$this->assertSame( 'test', get_option( 'tendr_mode' ) );
		$connection = get_option( 'tendr_connection' );
		$this->assertSame( 'con_a', $connection['id'] );
		$this->assertSame( 'Corner Shop a', $connection['store_name'] );
		$this->assertStringNotContainsString( 'tdr_', (string) wp_json_encode( $connection ) );
		$this->assertStringNotContainsString( 'whsec_', (string) wp_json_encode( $connection ) );
		$gateway = get_option( 'woocommerce_tendr_settings' );
		$this->assertSame( 'yes', $gateway['enabled'] );

		// Single use.
		$this->assertFalse( self::pending( $q['state'] ) );
		$again = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);
		$this->assertSame( 'error', $again['status'] );
		$this->assertCount( 1, $this->requests );
	}

	public function test_callback_access_denied_is_cancelled(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_token( self::issued() );

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'error' => 'access_denied',
			)
		);

		$this->assertSame( 'cancelled', $out['status'] );
		$this->assertSame( 'Connection cancelled', $out['message'] );
		$this->assertCount( 0, $this->requests );
		$this->assertFalse( self::pending( $q['state'] ) );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );

		$html = Tendr_Connect::render_callback_page( $out );
		$this->assertStringContainsString( 'Connection cancelled', $html );
		$this->assertStringContainsString( 'window.close()', $html );
	}

	public function test_callback_token_failure_stores_nothing(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_http(
			static fn() => self::response(
				400,
				array(
					'error' => array(
						'code'    => 'INVALID_GRANT',
						'message' => 'Invalid grant',
					),
				)
			)
		);

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'expired',
			)
		);

		$this->assertSame( 'error', $out['status'] );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
		$this->assertFalse( get_option( 'tendr_connection' ) );
	}

	public function test_callback_rejects_a_malformed_token_response(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_token( array( 'connection_id' => 'con_x' ) );
		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'c',
			)
		);
		$this->assertSame( 'error', $out['status'] );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
	}

	public function test_callback_page_carries_no_secrets(): void {
		$this->login_admin();
		$q      = $this->start_query();
		$issued = self::issued();
		$this->mock_token( $issued );
		$out  = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);
		$html = Tendr_Connect::render_callback_page( $out );
		$this->assertStringContainsString( 'window.close()', $html );
		$this->assertStringNotContainsString( 'tdr_', $html );
		$this->assertStringNotContainsString( 'whsec_', $html );
	}

	public function test_disconnect_calls_api_and_clears_credentials(): void {
		$this->login_admin();
		$issued = self::connect_locally();
		$this->mock_http( static fn() => self::response( 204 ) );

		Tendr_Connect::disconnect();

		$this->assertCount( 1, $this->requests );
		$this->assertSame( 'https://api.usetendr.tech/v1/connect/disconnect', $this->requests[0]['url'] );
		$this->assertSame( 'POST', $this->requests[0]['args']['method'] );
		$this->assertSame( 'Bearer ' . $issued['test']['secret_key'], $this->requests[0]['args']['headers']['Authorization'] );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
		$this->assertFalse( get_option( Tendr_Credentials::OPTION ) );
		$this->assertFalse( get_option( 'tendr_connection' ) );
		$this->assertSame( 'no', get_option( 'woocommerce_tendr_settings' )['enabled'] );
		$this->assertStringContainsString( 'Disconnected from tendr', Tendr_Settings::render() );
	}

	public function test_disconnect_clears_locally_even_when_the_api_fails(): void {
		$this->login_admin();
		self::connect_locally();
		$this->mock_http( static fn() => new WP_Error( 'http_request_failed', 'timeout' ) );

		Tendr_Connect::disconnect();

		$this->assertCount( 1, $this->requests );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
		$this->assertFalse( get_option( 'tendr_connection' ) );
		$this->assertStringContainsString( 'could not reach tendr', Tendr_Settings::render() );
	}

	public function test_disconnect_with_unreadable_credentials_clears_without_calling_api(): void {
		$this->login_admin();
		self::connect_locally();
		update_option( Tendr_Credentials::OPTION, 'v1:garbage', false );
		$this->mock_http( static fn() => self::response( 204 ) );

		Tendr_Connect::disconnect();

		$this->assertCount( 0, $this->requests );
		$this->assertFalse( get_option( 'tendr_connection' ) );
		$this->assertFalse( get_option( Tendr_Credentials::OPTION ) );
	}

	public function test_re_connect_replaces_stored_credentials(): void {
		$this->login_admin();
		self::connect_locally( 'a' );

		$q      = $this->start_query();
		$second = self::issued( 'b' );
		$this->mock_token( $second );
		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_2',
			)
		);

		$this->assertSame( 'connected', $out['status'] );
		$this->assertSame( $second['test'], Tendr_Credentials::get( 'test' ) );
		$this->assertSame( $second['live'], Tendr_Credentials::get( 'live' ) );
		$this->assertSame( 'con_b', get_option( 'tendr_connection' )['id'] );
		$this->assertSame( 'test', get_option( 'tendr_mode' ) );
	}
}
