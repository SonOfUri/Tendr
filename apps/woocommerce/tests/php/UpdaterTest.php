<?php
/**
 * Updates from usetendr.tech's feed (spec §9): offered through the standard WordPress hooks, and
 * the package is installed only when its sha256 matches the feed.
 *
 * @package Tendr
 */

/**
 * Tendr_Updater.
 */
class UpdaterTest extends Tendr_Test_Case {

	const FEED    = 'https://pay.usetendr.tech/v1/plugins/woocommerce/update.json';
	const PACKAGE = 'https://pay.usetendr.tech/downloads/woocommerce/tendr-pay-with-crypto-9.9.9.zip';
	const ZIP     = "PK\x03\x04 not really a zip, but bytes to hash";

	public function set_up(): void {
		parent::set_up();
		Tendr_Updater::forget();
	}

	/**
	 * A feed response for `$version` whose package hashes to `$sha256`.
	 *
	 * @param string      $version Version.
	 * @param string|null $sha256  Hash, default: the hash of self::ZIP.
	 * @param string      $url     Package URL.
	 */
	private function feed( string $version = '9.9.9', ?string $sha256 = null, string $url = self::PACKAGE ): array {
		return array(
			'version'      => $version,
			'download_url' => $url,
			'sha256'       => $sha256 ?? hash( 'sha256', self::ZIP ),
			'requires'     => '6.4',
			'tested'       => '7.1',
			'requires_php' => '8.0',
		);
	}

	/**
	 * Answer the feed with `$feed`, and the package with self::ZIP (written where WordPress asked).
	 *
	 * @param array|null $feed Feed body, or null for a 404.
	 */
	private function serve( ?array $feed ): void {
		$this->mock_http(
			function ( $url, $args ) use ( $feed ) {
				if ( self::FEED === $url ) {
					return null === $feed ? self::response( 404, array( 'error' => array( 'code' => 'NOT_FOUND' ) ) ) : self::response( 200, $feed );
				}
				if ( 0 === strpos( $url, 'https://pay.usetendr.tech/downloads/' ) ) {
					if ( ! empty( $args['filename'] ) ) {
						file_put_contents( $args['filename'], self::ZIP );
					}
					$response         = self::response( 200 );
					$response['body'] = empty( $args['filename'] ) ? self::ZIP : '';
					return $response;
				}
				return new WP_Error( 'http_request_failed', 'unexpected ' . $url );
			}
		);
	}

	/**
	 * The update_plugins transient as WordPress builds it before saving.
	 */
	private static function transient(): object {
		$t            = new stdClass();
		$t->checked   = array( plugin_basename( TENDR_PLUGIN_FILE ) => TENDR_VERSION );
		$t->response  = array();
		$t->no_update = array();
		return $t;
	}

	public function test_updater_offers_update_from_feed(): void {
		$this->serve( $this->feed() );
		$basename = plugin_basename( TENDR_PLUGIN_FILE );

		$t = apply_filters( 'pre_set_site_transient_update_plugins', self::transient() );

		$this->assertArrayHasKey( $basename, $t->response );
		$offer = $t->response[ $basename ];
		$this->assertSame( '9.9.9', $offer->new_version );
		$this->assertSame( self::PACKAGE, $offer->package );
		$this->assertSame( 'tendr-pay-with-crypto', $offer->slug );
		$this->assertSame( $basename, $offer->plugin );
		$this->assertSame( '7.1', $offer->tested );
		$this->assertSame( '8.0', $offer->requires_php );
		$this->assertSame( self::FEED, $this->requests[0]['url'] );
		$this->assertTrue( $this->requests[0]['args']['sslverify'] );

		// The feed is cached: a second check makes no request.
		apply_filters( 'pre_set_site_transient_update_plugins', self::transient() );
		$this->assertCount( 1, $this->requests );

		// "View details" reads the same feed.
		$info = apply_filters( 'plugins_api', false, 'plugin_information', (object) array( 'slug' => 'tendr-pay-with-crypto' ) );
		$this->assertIsObject( $info );
		$this->assertSame( '9.9.9', $info->version );
		$this->assertSame( self::PACKAGE, $info->download_link );
		$this->assertArrayHasKey( 'description', $info->sections );
		// Other plugins' details are left alone.
		$this->assertFalse( apply_filters( 'plugins_api', false, 'plugin_information', (object) array( 'slug' => 'akismet' ) ) );
	}

	public function test_same_or_older_version_is_not_offered(): void {
		$basename = plugin_basename( TENDR_PLUGIN_FILE );
		foreach ( array( TENDR_VERSION, '0.0.1' ) as $version ) {
			Tendr_Updater::forget();
			remove_all_filters( 'pre_http_request' );
			$this->serve( $this->feed( $version ) );
			$t = apply_filters( 'pre_set_site_transient_update_plugins', self::transient() );
			$this->assertArrayNotHasKey( $basename, $t->response, $version );
			$this->assertArrayHasKey( $basename, $t->no_update, $version );
		}
	}

	public function test_no_release_or_unreachable_feed_offers_nothing(): void {
		$basename = plugin_basename( TENDR_PLUGIN_FILE );
		$this->serve( null );
		$t = apply_filters( 'pre_set_site_transient_update_plugins', self::transient() );
		$this->assertArrayNotHasKey( $basename, $t->response );
		// A transient that WordPress has not filled in yet is returned untouched, with no request.
		Tendr_Updater::forget();
		$this->requests = array();
		$empty          = new stdClass();
		$this->assertSame( $empty, apply_filters( 'pre_set_site_transient_update_plugins', $empty ) );
		$this->assertSame( array(), $this->requests );
	}

	public function test_malformed_or_foreign_feed_is_ignored(): void {
		$basename = plugin_basename( TENDR_PLUGIN_FILE );
		$bad      = array(
			'bad version'     => $this->feed( 'latest' ),
			'bad sha256'      => $this->feed( '9.9.9', 'abc' ),
			'other host'      => $this->feed( '9.9.9', null, 'https://evil.example/tendr.zip' ),
			'http package'    => $this->feed( '9.9.9', null, 'http://pay.usetendr.tech/downloads/woocommerce/t.zip' ),
			'not a zip'       => $this->feed( '9.9.9', null, 'https://pay.usetendr.tech/downloads/woocommerce/t.php' ),
			'userinfo in url' => $this->feed( '9.9.9', null, 'https://a@pay.usetendr.tech/downloads/woocommerce/t.zip' ),
		);
		foreach ( $bad as $label => $feed ) {
			Tendr_Updater::forget();
			remove_all_filters( 'pre_http_request' );
			$this->serve( $feed );
			$t = apply_filters( 'pre_set_site_transient_update_plugins', self::transient() );
			$this->assertArrayNotHasKey( $basename, $t->response, $label );
		}
	}

	public function test_feed_origin_is_https_except_a_local_origin_outside_production(): void {
		$this->assertSame( self::FEED, Tendr_Updater::feed_url( 'https://pay.usetendr.tech', 'production' ) );
		$this->assertNull( Tendr_Updater::feed_url( 'http://pay.usetendr.tech', 'production' ) );
		$this->assertNull( Tendr_Updater::feed_url( 'http://localhost:3100', 'production' ) );
		$this->assertSame( 'http://localhost:3100/v1/plugins/woocommerce/update.json', Tendr_Updater::feed_url( 'http://localhost:3100', 'local' ) );
		$this->assertSame( 'http://host.docker.internal:3100/v1/plugins/woocommerce/update.json', Tendr_Updater::feed_url( 'http://host.docker.internal:3100', 'development' ) );
		$this->assertNull( Tendr_Updater::feed_url( 'http://shop.example:3100', 'local' ) );
		$this->assertNull( Tendr_Updater::feed_url( 'ftp://pay.usetendr.tech', 'local' ) );
	}

	public function test_checksum_mismatch_aborts_install(): void {
		$this->serve( $this->feed( '9.9.9', str_repeat( 'a', 64 ) ) );
		$before = glob( get_temp_dir() . '*' );

		$reply = apply_filters( 'upgrader_pre_download', false, self::PACKAGE, null, array( 'plugin' => plugin_basename( TENDR_PLUGIN_FILE ) ) );

		$this->assertWPError( $reply );
		$this->assertSame( 'tendr_checksum_mismatch', $reply->get_error_code() );
		// The downloaded file is deleted.
		$this->assertSame( $before, glob( get_temp_dir() . '*' ) );
	}

	public function test_matching_checksum_hands_the_verified_file_to_the_upgrader(): void {
		$this->serve( $this->feed() );

		$reply = apply_filters( 'upgrader_pre_download', false, self::PACKAGE, null, array( 'plugin' => plugin_basename( TENDR_PLUGIN_FILE ) ) );

		$this->assertIsString( $reply );
		$this->assertFileExists( $reply );
		$this->assertSame( hash( 'sha256', self::ZIP ), hash_file( 'sha256', $reply ) );
		wp_delete_file( $reply );
	}

	public function test_package_not_in_the_feed_is_refused(): void {
		$this->serve( $this->feed() );
		$reply = apply_filters( 'upgrader_pre_download', false, 'https://pay.usetendr.tech/downloads/woocommerce/other.zip', null, array( 'plugin' => plugin_basename( TENDR_PLUGIN_FILE ) ) );
		$this->assertWPError( $reply );
		$this->assertSame( 'tendr_package_unknown', $reply->get_error_code() );
	}

	public function test_other_downloads_are_left_alone(): void {
		$this->serve( $this->feed() );
		$this->assertFalse( apply_filters( 'upgrader_pre_download', false, 'https://downloads.wordpress.org/plugin/akismet.zip', null, array( 'plugin' => 'akismet/akismet.php' ) ) );
		// An earlier filter's answer is kept.
		$this->assertSame( '/tmp/x.zip', apply_filters( 'upgrader_pre_download', '/tmp/x.zip', self::PACKAGE, null, array() ) );
		$this->assertSame( array(), $this->requests );
	}
}
