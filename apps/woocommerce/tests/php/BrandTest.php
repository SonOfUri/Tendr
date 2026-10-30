<?php
/**
 * The brand sent to tendr: collected from the site, sent after Connect and on demand.
 *
 * @package Tendr
 */

/**
 * Tendr_Brand.
 */
class BrandTest extends Tendr_Test_Case {

	public function set_up(): void {
		parent::set_up();
		add_filter( 'wp_get_attachment_url', array( self::class, 'https' ) );
	}

	public function tear_down(): void {
		remove_all_filters( 'wp_theme_json_data_theme' );
		WP_Theme_JSON_Resolver::clean_cached_data();
		$_POST = array();
		parent::tear_down();
	}

	/**
	 * Make an attachment URL https.
	 *
	 * @param mixed $url URL.
	 */
	public static function https( $url ): string {
		return (string) preg_replace( '#^http://#', 'https://', (string) $url );
	}

	private static function image(): int {
		return self::factory()->attachment->create_upload_object( DIR_TESTDATA . '/images/canola.jpg' );
	}

	public function test_brand_collect_reads_logo_icon_and_palette(): void {
		update_option( 'blogname', 'Corner Shop' );
		$logo = self::image();
		set_theme_mod( 'custom_logo', $logo );
		update_option( 'site_icon', self::image() );
		add_filter(
			'wp_theme_json_data_theme',
			static function ( $data ) {
				return $data->update_with(
					array(
						'version'  => 2,
						'settings' => array(
							'color' => array(
								'palette' => array(
									array(
										'slug'  => 'brand',
										'name'  => 'Brand',
										'color' => '#1A2B3C',
									),
									array(
										'slug'  => 'short',
										'name'  => 'Short',
										'color' => '#abc',
									),
									array(
										'slug'  => 'grad',
										'name'  => 'Grad',
										'color' => 'linear-gradient(red, blue)',
									),
									array(
										'slug'  => 'dupe',
										'name'  => 'Dupe',
										'color' => '#1a2b3c',
									),
								),
							),
						),
					)
				);
			}
		);
		WP_Theme_JSON_Resolver::clean_cached_data();

		$brand = Tendr_Brand::collect();
		$this->assertSame( 'Corner Shop', $brand['site_name'] );
		$this->assertSame( wp_get_attachment_image_url( $logo, 'full' ), $brand['logo_url'] );
		$this->assertStringStartsWith( 'https://', $brand['logo_url'] );
		$this->assertStringStartsWith( 'https://', $brand['icon_url'] );
		$this->assertSame( array( '#1a2b3c', '#aabbcc' ), $brand['palette'] );
	}

	public function test_collect_leaves_out_what_the_store_does_not_have(): void {
		$brand = Tendr_Brand::collect();
		$this->assertArrayNotHasKey( 'logo_url', $brand );
		$this->assertArrayNotHasKey( 'icon_url', $brand );
		$this->assertIsArray( $brand['palette'] );

		// The test site is plain http: tendr only takes https.
		remove_filter( 'wp_get_attachment_url', array( self::class, 'https' ) );
		set_theme_mod( 'custom_logo', self::image() );
		$this->assertArrayNotHasKey( 'logo_url', Tendr_Brand::collect() );
	}

	public function test_send_puts_the_brand_with_the_connection_key(): void {
		$issued = self::connect_locally();
		$this->mock_http( static fn() => self::response( 200, array( 'ok' => true ) ) );
		$result = Tendr_Brand::send();
		$this->assertNotWPError( $result );
		$this->assertCount( 1, $this->requests );
		$this->assertSame( 'PUT', $this->requests[0]['args']['method'] );
		$this->assertSame( 'https://api.usetendr.tech/v1/connection/brand', $this->requests[0]['url'] );
		$this->assertSame( 'Bearer ' . $issued['test']['secret_key'], $this->requests[0]['args']['headers']['Authorization'] );
		$this->assertArrayHasKey( 'palette', json_decode( $this->requests[0]['args']['body'], true ) );
	}

	public function test_connect_still_succeeds_when_the_brand_cannot_be_sent(): void {
		$this->login_admin();
		$q = self::query_of( (string) Tendr_Connect::start() );
		$this->mock_http(
			static function ( $url ) {
				return str_ends_with( $url, '/v1/connect/token' ) ? self::response( 200, self::issued() ) : self::response( 503, null );
			}
		);
		$out = Tendr_Connect::handle_callback(
			array(
				'state' => $q['state'],
				'code'  => 'code_1',
			)
		);
		$this->assertSame( 'connected', $out['status'] );
		$this->assertTrue( Tendr_Connect::is_connected() );
		$paths = array_map( static fn( $r ) => $r['args']['method'] . ' ' . wp_parse_url( $r['url'], PHP_URL_PATH ), $this->requests );
		$this->assertContains( 'PUT /v1/connection/brand', $paths );
		$this->mock_http( static fn() => self::response( 503, null ) );
		$this->assertStringContainsString( 'could not be sent to tendr yet', Tendr_Settings::render() );
	}

	public function test_refresh_requires_nonce_and_capability(): void {
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 200, array( 'ok' => true ) ) );

		// An administrator without a nonce.
		$this->login_admin();
		$_POST = array();
		try {
			Tendr_Brand::handle_refresh_request();
			$this->fail( 'expected wp_die' );
		} catch ( WPDieException $e ) {
			$this->assertStringContainsString( 'not allowed', $e->getMessage() );
		}

		// A valid nonce without the capability.
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );
		$_POST = array( 'tendr_brand_nonce' => wp_create_nonce( Tendr_Brand::NONCE ) );
		try {
			Tendr_Brand::handle_refresh_request();
			$this->fail( 'expected wp_die' );
		} catch ( WPDieException $e ) {
			$this->assertStringContainsString( 'not allowed', $e->getMessage() );
		}
		$this->assertCount( 0, $this->requests, 'nothing was sent' );
	}

	public function test_the_settings_page_has_a_nonce_protected_refresh_button(): void {
		$this->login_admin();
		self::connect_locally();
		$this->mock_http( static fn() => self::response( 503, null ) );
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Refresh brand from my store', $html );
		$this->assertStringContainsString( 'action=tendr_refresh_brand', $html );
		$this->assertStringContainsString( 'name="tendr_brand_nonce"', $html );
	}
}
