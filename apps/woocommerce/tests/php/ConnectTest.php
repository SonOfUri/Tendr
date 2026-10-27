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
		// The first admin's attempt is untouched: their popup can still finish.
		$this->assertIsArray( self::pending( $q['state'] ) );
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

	// ---------------------------------------------------------------- A3: re-connect at a new address.

	/**
	 * Mock the token exchange (answering `$issued`) and `/v1/connect/replace` (answering
	 * `$replace`: [status, json|null]).
	 *
	 * @param array $issued  Token response.
	 * @param array $replace Replace answer.
	 */
	private function mock_reconnect( array $issued, array $replace ): void {
		$this->mock_http(
			static function ( $url ) use ( $issued, $replace ) {
				if ( str_ends_with( $url, '/v1/connect/token' ) ) {
					return self::response( 200, $issued );
				}
				if ( str_ends_with( $url, '/v1/connect/replace' ) ) {
					return self::response( $replace[0], $replace[1] );
				}
				return self::response( 500, null );
			}
		);
	}

	/**
	 * The requests made to a path.
	 *
	 * @param string $path Path suffix.
	 */
	private function requests_to( string $path ): array {
		return array_values( array_filter( $this->requests, static fn( $r ) => str_ends_with( $r['url'], $path ) ) );
	}

	public function test_re_connect_hands_the_old_connections_orders_to_the_new_one(): void {
		$this->login_admin();
		$old = self::connect_locally( 'a' );
		$q   = $this->start_query();
		$new = self::issued( 'b' );
		$this->mock_reconnect(
			$new,
			array(
				200,
				array(
					'connection_id' => 'con_a',
					'replaced_by'   => 'con_b',
				),
			)
		);

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_2',
			)
		);

		$this->assertSame( 'connected', $out['status'] );
		$this->assertArrayNotHasKey( 'notice', $out );
		$replace = $this->requests_to( '/v1/connect/replace' );
		$this->assertCount( 1, $replace, 'after the token exchange' );
		$this->assertSame( 'POST', $replace[0]['args']['method'] );
		$this->assertContains(
			$replace[0]['args']['headers']['Authorization'],
			array( 'Bearer ' . $old['test']['secret_key'], 'Bearer ' . $old['live']['secret_key'] ),
			'authenticated with the OLD connection key'
		);
		$this->assertSame( array( 'successor_connection_id' => 'con_b' ), json_decode( $replace[0]['args']['body'], true ) );
		$this->assertSame( $new['test'], Tendr_Credentials::get( 'test' ) );
		$this->assertSame( $new['live'], Tendr_Credentials::get( 'live' ) );
		$stored = (string) get_option( Tendr_Credentials::OPTION );
		foreach ( self::secrets_of( $old ) as $secret ) {
			$this->assertStringNotContainsString( $secret, $stored );
		}
	}

	public function test_a_failed_replace_keeps_the_new_connection_and_warns(): void {
		$this->login_admin();
		self::connect_locally( 'a' );
		$q   = $this->start_query();
		$new = self::issued( 'b' );
		$this->mock_reconnect( $new, array( 503, null ) );

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_2',
			)
		);

		$this->assertSame( 'connected', $out['status'] );
		$this->assertStringContainsString( 'orders placed before', $out['notice'] ?? '' );
		$this->assertSame( $new['test'], Tendr_Credentials::get( 'test' ) );
		$this->assertSame( 'con_b', get_option( 'tendr_connection' )['id'] );
	}

	public function test_a_replace_answered_401_was_already_done_and_is_quiet(): void {
		$this->login_admin();
		self::connect_locally( 'a' );
		$q = $this->start_query();
		$this->mock_reconnect(
			self::issued( 'b' ),
			array(
				401,
				array(
					'error' => array(
						'code'    => 'UNAUTHORIZED',
						'message' => 'Unauthorized',
					),
				),
			)
		);

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_2',
			)
		);

		$this->assertSame( 'connected', $out['status'] );
		$this->assertArrayNotHasKey( 'notice', $out );
	}

	public function test_a_failed_token_exchange_keeps_the_old_connection(): void {
		$this->login_admin();
		$old = self::connect_locally( 'a' );
		$q   = $this->start_query();
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
				'code'  => 'bad',
			)
		);

		$this->assertSame( 'error', $out['status'] );
		$this->assertSame( $old['test'], Tendr_Credentials::get( 'test' ) );
		$this->assertCount( 0, $this->requests_to( '/v1/connect/replace' ) );
	}

	// ---------------------------------------------------------------- A4: disconnect and open orders.

	/**
	 * A tendr order with a session.
	 *
	 * @param string $status  Order status.
	 * @param string $gateway Payment method.
	 */
	private static function tendr_order( string $status, string $gateway = 'tendr' ): WC_Order {
		$order = wc_create_order();
		$order->set_payment_method( $gateway );
		$order->set_total( '10.00' );
		$order->set_status( $status );
		$order->update_meta_data( Tendr_Gateway::META_SESSION_ID, 'ses_01JOPEN' . wp_rand( 1000, 9999 ) );
		$order->save();
		return wc_get_order( $order->get_id() );
	}

	public function test_disconnect_confirmation_counts_orders_waiting_for_a_crypto_payment(): void {
		$this->login_admin();
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 503, null ) );
		self::tendr_order( 'pending' );
		self::tendr_order( 'pending' );
		self::tendr_order( 'processing' );
		self::tendr_order( 'pending', 'bacs' );

		$this->assertSame( 2, Tendr_Connect::open_order_count() );
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( '2 orders are waiting for a crypto payment', html_entity_decode( $html, ENT_QUOTES ) );
	}

	public function test_disconnect_notes_every_order_still_waiting_for_a_crypto_payment(): void {
		$this->login_admin();
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 204 ) );
		$waiting = self::tendr_order( 'pending' );
		$paid    = self::tendr_order( 'processing' );

		Tendr_Connect::disconnect();

		$notes = static fn( WC_Order $o ) => implode( "\n", array_map( static fn( $n ) => (string) $n->content, wc_get_order_notes( array( 'order_id' => $o->get_id() ) ) ) );
		$this->assertStringContainsString( 'tendr disconnected — a payment for this order will not be reported here; check the tendr dashboard.', $notes( $waiting ) );
		$this->assertStringNotContainsString( 'tendr disconnected', $notes( $paid ) );
	}

	// ---------------------------------------------------------------- C1: placeholder salts.

	/**
	 * Fake the wp-config.php salt constants.
	 *
	 * @param array $values Constant name => value.
	 */
	private static function salts( array $values ): void {
		add_filter( 'tendr_salt_constants', static fn( $current ) => array_merge( $current, $values ) );
	}

	public function test_salt_problem_detects_placeholders_empty_and_shared_values(): void {
		$good = array(
			'AUTH_KEY'         => 'a-long-random-auth-key-1',
			'SECURE_AUTH_KEY'  => 'a-long-random-secure-key-2',
			'LOGGED_IN_KEY'    => 'k3',
			'NONCE_KEY'        => 'k4',
			'AUTH_SALT'        => 's1',
			'SECURE_AUTH_SALT' => 's2',
			'LOGGED_IN_SALT'   => 's3',
			'NONCE_SALT'       => 's4',
		);
		$this->assertNull( Tendr_Credentials::salt_problem( $good ) );
		$this->assertNotNull( Tendr_Credentials::salt_problem( array_merge( $good, array( 'AUTH_KEY' => 'put your unique phrase here' ) ) ) );
		$this->assertNotNull( Tendr_Credentials::salt_problem( array_merge( $good, array( 'SECURE_AUTH_KEY' => '' ) ) ) );
		$this->assertNotNull( Tendr_Credentials::salt_problem( array_merge( $good, array( 'SECURE_AUTH_KEY' => null ) ) ), 'not defined' );
		$this->assertNotNull( Tendr_Credentials::salt_problem( array_merge( $good, array( 'NONCE_SALT' => $good['AUTH_KEY'] ) ) ), 'shared with another salt' );
	}

	public function test_placeholder_salts_refuse_connect_and_storing_credentials(): void {
		$this->login_admin();
		self::salts( array( 'AUTH_KEY' => 'put your unique phrase here' ) );

		$start = Tendr_Connect::start();
		$this->assertWPError( $start );
		$this->assertSame( 'tendr_salts', $start->get_error_code() );
		$this->assertStringContainsString( 'wp-config.php', $start->get_error_message() );

		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'https://api.wordpress.org/secret-key/1.1/salt/', $html );
		$this->assertMatchesRegularExpression( '/<button[^>]*disabled/', $html );

		$this->expectException( InvalidArgumentException::class );
		Tendr_Credentials::store( self::issued() );
	}

	public function test_placeholder_salts_refuse_a_callback_before_the_token_exchange(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_token( self::issued() );
		self::salts( array( 'SECURE_AUTH_KEY' => '' ) );

		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);

		$this->assertSame( 'error', $out['status'] );
		$this->assertStringContainsString( 'wp-config.php', $out['message'] );
		$this->assertCount( 0, $this->requests, 'the code is never exchanged' );
		$this->assertFalse( get_option( Tendr_Credentials::OPTION ) );
	}

	public function test_placeholder_salts_show_a_site_wide_notice_to_managers(): void {
		self::salts( array( 'AUTH_KEY' => 'put your unique phrase here' ) );
		$this->assertSame( '', Tendr_Settings::admin_notices_html(), 'guests see nothing' );
		$this->login_admin();
		$this->assertStringContainsString( 'security keys', Tendr_Settings::admin_notices_html() );
	}

	// ---------------------------------------------------------------- C2: the request paths.

	public function test_the_callback_request_path_flashes_the_result_and_prints_the_popup_page(): void {
		$this->login_admin();
		$q = $this->start_query();
		$this->mock_token( self::issued() );
		$_GET = array(
			'page'  => Tendr_Connect::CALLBACK_PAGE,
			'state' => $q['state'],
			'code'  => 'code_1',
		);
		try {
			$html = Tendr_Connect::callback_page_for_request();
		} finally {
			$_GET = array();
		}
		$this->assertStringContainsString( 'Connected to Corner Shop a', $html );
		$this->assertStringContainsString( 'window.close()', $html );
		$this->assertTrue( Tendr_Connect::is_connected() );
		$this->mock_http( static fn() => self::response( 503, null ) );
		$this->assertStringContainsString( 'Connected to Corner Shop a', Tendr_Settings::render(), 'flashed for the settings page' );
	}

	public function test_disconnect_needs_a_post_with_its_nonce(): void {
		$this->login_admin();
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 204 ) );

		$_SERVER['REQUEST_METHOD'] = 'GET';
		$_GET                      = array( '_wpnonce' => wp_create_nonce( 'tendr_disconnect' ) );
		$this->assertFalse( Tendr_Connect::disconnect_from_request(), 'a GET link never disconnects' );
		$this->assertTrue( Tendr_Connect::is_connected() );

		$_SERVER['REQUEST_METHOD'] = 'POST';
		$_GET                      = array();
		$_POST                     = array( 'tendr_disconnect_nonce' => 'nope' );
		$this->assertFalse( Tendr_Connect::disconnect_from_request() );
		$this->assertTrue( Tendr_Connect::is_connected() );

		$_POST = array( 'tendr_disconnect_nonce' => wp_create_nonce( 'tendr_disconnect' ) );
		try {
			$this->assertTrue( Tendr_Connect::disconnect_from_request() );
		} finally {
			$_POST                     = array();
			$_SERVER['REQUEST_METHOD'] = 'GET';
		}
		$this->assertFalse( Tendr_Connect::is_connected() );
	}
}
