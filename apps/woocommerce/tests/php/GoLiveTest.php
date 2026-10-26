<?php
/**
 * The Test / Live switch and the store settings written through the API (spec §3).
 *
 * @package Tendr
 */

/**
 * Tendr_Settings: go live, settings write-through.
 */
class GoLiveTest extends Tendr_Test_Case {

	/**
	 * Credentials stored by connect_locally().
	 *
	 * @var array
	 */
	private array $issued = array();

	/**
	 * `GET /v1/connect/status` reply: [status, json].
	 *
	 * @var array
	 */
	private array $status_reply = array();

	/**
	 * The store settings the mocked API holds.
	 *
	 * @var array
	 */
	private array $store = array();

	/**
	 * PATCH bodies received.
	 *
	 * @var array<int, array>
	 */
	private array $patches = array();

	public function set_up(): void {
		parent::set_up();
		$this->issued  = self::connect_locally();
		$this->patches = array();
		$this->store   = array(
			'checkout_domains'           => array( 'http://example.org' ),
			'default_fee_payer'          => 'merchant',
			'default_gas_payer'          => 'merchant',
			'notification_email'         => null,
			'notification_email_pending' => null,
			'payment_emails_enabled'     => true,
		);
		$this->mock_http( fn( $url, $args ) => $this->api( $url, $args ) );
		$this->login_admin();
	}

	/**
	 * The mocked API.
	 *
	 * @param string $url  URL.
	 * @param array  $args Request args.
	 */
	private function api( string $url, array $args ): array {
		$path = (string) wp_parse_url( $url, PHP_URL_PATH );
		if ( '/v1/connect/status' === $path ) {
			return self::response( $this->status_reply[0], $this->status_reply[1] );
		}
		if ( '/v1/settings/checkout' === $path && 'GET' === $args['method'] ) {
			return self::response( 200, $this->store );
		}
		if ( '/v1/settings/checkout' === $path && 'PATCH' === $args['method'] ) {
			$body            = json_decode( (string) $args['body'], true );
			$this->patches[] = $body;
			foreach ( array( 'default_fee_payer', 'default_gas_payer' ) as $key ) {
				if ( isset( $body[ $key ] ) ) {
					$this->store[ $key ] = $body[ $key ];
				}
			}
			if ( array_key_exists( 'notification_email', $body ) ) {
				// A new address waits for its verify link; it is not the notification email yet.
				$this->store['notification_email_pending'] = $body['notification_email'];
			}
			return self::response( 200, $this->store );
		}
		return self::response( 500, null );
	}

	/**
	 * A status body.
	 *
	 * @param bool  $ready    Ready.
	 * @param array $blocking Blocking items.
	 * @param array $nudges   Nudges.
	 */
	private function status( bool $ready, array $blocking = array(), array $nudges = array() ): void {
		$this->status_reply = array(
			200,
			array(
				'connection_id' => 'con_a',
				'mode'          => 'live',
				'ready'         => $ready,
				'blocking'      => $blocking,
				'nudges'        => $nudges,
			),
		);
	}

	/**
	 * The single_key nudge as the API sends it.
	 */
	private static function nudge(): array {
		return array(
			'code'    => 'single_key',
			'message' => "Add a second device or a co-owner so a lost phone can't lock you out",
			'href'    => Tendr_Plugin::checkout_base() . '/dashboard/onboarding/second-key',
		);
	}

	// ---------------------------------------------------------------- go live.

	public function test_go_live_blocked_lists_messages_and_ready_switches_mode(): void {
		$this->status(
			false,
			array(
				array(
					'code'    => 'live_account_missing',
					'message' => 'Finish going live on your tendr dashboard',
					'href'    => Tendr_Plugin::checkout_base() . '/dashboard',
				),
				array(
					'code'    => 'payout_missing',
					'message' => 'Add a payout method',
					'href'    => Tendr_Plugin::checkout_base() . '/dashboard/settings/payout',
				),
			),
			array( self::nudge() )
		);

		$result = Tendr_Settings::set_mode( 'live' );

		$this->assertFalse( $result['switched'] );
		$this->assertSame( 'test', Tendr_Connect::mode() );
		$request = end( $this->requests );
		$this->assertStringEndsWith( '/v1/connect/status', $request['url'] );
		$this->assertSame( 'Bearer ' . $this->issued['live']['secret_key'], $request['args']['headers']['Authorization'], 'status is asked with the LIVE key' );

		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Finish going live on your tendr dashboard', $html );
		$this->assertStringContainsString( 'Add a payout method', $html );
		$this->assertStringContainsString( 'href="' . Tendr_Plugin::checkout_base() . '/dashboard/settings/payout"', $html );
		$this->assertStringContainsString( 'lock you out', $html, 'nudges are always shown' );
		$this->assertStringContainsString( 'Test mode', $html );

		// The store finishes going live.
		$this->status( true, array(), array( self::nudge() ) );
		$result = Tendr_Settings::set_mode( 'live' );

		$this->assertTrue( $result['switched'] );
		$this->assertSame( 'live', Tendr_Connect::mode() );
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Live mode', $html );
		$this->assertStringContainsString( 'lock you out', $html, 'nudges are shown even when ready' );
		$this->assertStringNotContainsString( 'Add a payout method', $html );
	}

	public function test_go_live_stays_in_test_mode_when_status_cannot_be_read(): void {
		$this->status_reply = array( 503, null );

		$result = Tendr_Settings::set_mode( 'live' );

		$this->assertFalse( $result['switched'] );
		$this->assertNotNull( $result['error'] );
		$this->assertSame( 'test', Tendr_Connect::mode() );
	}

	public function test_a_blocking_link_off_the_tendr_site_is_not_rendered(): void {
		$this->status(
			false,
			array(
				array(
					'code'    => 'payout_missing',
					'message' => 'Add a payout method',
					'href'    => 'https://evil.example/phish',
				),
			)
		);
		Tendr_Settings::set_mode( 'live' );

		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Add a payout method', $html );
		$this->assertStringNotContainsString( 'evil.example', $html );
	}

	public function test_switching_back_to_test_needs_no_check(): void {
		update_option( Tendr_Connect::MODE, 'live' );

		$result = Tendr_Settings::set_mode( 'test' );

		$this->assertTrue( $result['switched'] );
		$this->assertSame( 'test', Tendr_Connect::mode() );
		$this->assertSame( array(), array_filter( $this->requests, static fn( $r ) => str_contains( $r['url'], '/connect/status' ) ) );
	}

	public function test_mode_request_needs_a_nonce_and_the_capability(): void {
		$this->status( true );
		$_POST['tendr_mode']       = 'live';
		$_POST['tendr_mode_nonce'] = 'bad';
		try {
			Tendr_Settings::handle_mode_request();
			$this->fail( 'a bad nonce must stop the request' );
		} catch ( WPDieException $e ) {
			$this->assertSame( 'test', Tendr_Connect::mode() );
		}

		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );
		$_POST['tendr_mode_nonce'] = wp_create_nonce( 'tendr_mode' );
		try {
			Tendr_Settings::handle_mode_request();
			$this->fail( 'a customer must not switch modes' );
		} catch ( WPDieException $e ) {
			$this->assertSame( 'test', Tendr_Connect::mode() );
		} finally {
			unset( $_POST['tendr_mode'], $_POST['tendr_mode_nonce'] );
		}
	}

	// ---------------------------------------------------------------- settings.

	public function test_settings_save_calls_patch_and_shows_confirm_inbox_notice(): void {
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Applies to all sites connected to this store', $html );
		$this->assertMatchesRegularExpression( '/name="tendr_fee_payer"/', $html );
		$this->assertMatchesRegularExpression( '/name="tendr_gas_payer"/', $html );
		$this->assertMatchesRegularExpression( '/name="tendr_notification_email"/', $html );

		$result = Tendr_Settings::save_settings(
			array(
				'default_fee_payer'  => 'shopper',
				'default_gas_payer'  => 'merchant',
				'notification_email' => 'Orders@Example.com',
			)
		);

		$this->assertNotWPError( $result );
		$this->assertSame(
			array(
				array(
					'default_fee_payer'  => 'shopper',
					'notification_email' => 'orders@example.com',
				),
			),
			$this->patches,
			'only the changed fields are sent'
		);
		$patch = end( $this->requests );
		$this->assertSame( 'PATCH', $patch['args']['method'] );
		$this->assertSame( 'Bearer ' . $this->issued['test']['secret_key'], $patch['args']['headers']['Authorization'] );

		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Check your inbox to confirm', $html );
		$this->assertStringContainsString( 'orders@example.com', $html );
		// The display is the API's answer: the fee payer is now the shopper.
		$this->assertMatchesRegularExpression( '/<option value="shopper" selected/', $html );
	}

	public function test_settings_display_reflects_the_api_not_local_input(): void {
		// The API keeps the fee payer as merchant whatever was asked (e.g. another site changed it).
		$this->store['default_gas_payer'] = 'shopper';

		$html = Tendr_Settings::render();

		$this->assertMatchesRegularExpression( '/name="tendr_gas_payer".*?<option value="shopper" selected/s', $html );
	}

	public function test_invalid_settings_are_refused_without_a_request(): void {
		$result = Tendr_Settings::save_settings( array( 'default_fee_payer' => 'everyone' ) );
		$this->assertWPError( $result );
		$result = Tendr_Settings::save_settings( array( 'notification_email' => 'not an email' ) );
		$this->assertWPError( $result );
		$this->assertSame( array(), $this->patches );
	}

	public function test_clearing_the_email_returns_notices_to_the_owners(): void {
		$this->store['notification_email'] = 'old@example.com';

		Tendr_Settings::save_settings( array( 'notification_email' => '' ) );

		$this->assertSame( array( array( 'notification_email' => null ) ), $this->patches );
	}

	public function test_settings_request_needs_a_nonce(): void {
		$_POST['tendr_settings_nonce'] = 'bad';
		$_POST['tendr_fee_payer']      = 'shopper';
		try {
			Tendr_Settings::handle_settings_request();
			$this->fail( 'a bad nonce must stop the request' );
		} catch ( WPDieException $e ) {
			$this->assertSame( array(), $this->patches );
		} finally {
			unset( $_POST['tendr_settings_nonce'], $_POST['tendr_fee_payer'] );
		}
	}
}
