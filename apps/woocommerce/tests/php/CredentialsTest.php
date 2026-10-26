<?php
/**
 * Encrypted credential storage.
 *
 * @package Tendr
 */

/**
 * Tendr_Credentials.
 */
class CredentialsTest extends Tendr_Test_Case {

	public function test_credentials_round_trip_encrypted_raw_option_value_contains_no_key_prefix_tdr(): void {
		$issued = self::issued();
		Tendr_Credentials::store( $issued );

		$this->assertSame( $issued['test'], Tendr_Credentials::get( 'test' ) );
		$this->assertSame( $issued['live'], Tendr_Credentials::get( 'live' ) );
		$this->assertSame( 'ok', Tendr_Credentials::status() );

		$raw = (string) get_option( Tendr_Credentials::OPTION );
		$this->assertNotSame( '', $raw );
		$this->assertStringNotContainsString( 'tdr_', $raw );
		$this->assertStringNotContainsString( 'whsec_', $raw );
		foreach ( self::secrets_of( $issued ) as $secret ) {
			$this->assertStringNotContainsString( $secret, $raw );
		}
	}

	public function test_credentials_option_is_not_autoloaded(): void {
		global $wpdb;
		Tendr_Credentials::store( self::issued() );
		$autoload = $wpdb->get_var( $wpdb->prepare( "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", Tendr_Credentials::OPTION ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$this->assertContains( $autoload, array( 'no', 'off' ) );
	}

	public function test_each_store_uses_a_fresh_nonce(): void {
		Tendr_Credentials::store( self::issued() );
		$first = get_option( Tendr_Credentials::OPTION );
		Tendr_Credentials::store( self::issued() );
		$this->assertNotSame( $first, get_option( Tendr_Credentials::OPTION ) );
	}

	public function test_unknown_mode_and_missing_credentials_return_null(): void {
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
		$this->assertSame( 'none', Tendr_Credentials::status() );
		Tendr_Credentials::store( self::issued() );
		$this->assertNull( Tendr_Credentials::get( 'staging' ) );
	}

	public function test_store_rejects_an_incomplete_response(): void {
		$issued = self::issued();
		unset( $issued['live']['webhook_secret'] );
		$this->expectException( InvalidArgumentException::class );
		Tendr_Credentials::store( $issued );
	}

	public function test_clear_removes_the_credentials(): void {
		Tendr_Credentials::store( self::issued() );
		Tendr_Credentials::clear();
		$this->assertFalse( get_option( Tendr_Credentials::OPTION ) );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
	}

	public function test_changed_salts_read_as_disconnected_without_a_fatal(): void {
		// Credentials sealed under other salts: what the option holds after AUTH_KEY / SECURE_AUTH_KEY change.
		$other_key = sodium_crypto_generichash( 'other-auth-key|other-secure-auth-key', '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
		update_option( Tendr_Credentials::OPTION, Tendr_Credentials::seal( (string) wp_json_encode( self::issued() ), $other_key ), false );

		$this->assertNull( Tendr_Credentials::get( 'test' ) );
		$this->assertSame( 'unreadable', Tendr_Credentials::status() );
	}

	public function test_a_corrupt_option_reads_as_unreadable(): void {
		update_option( Tendr_Credentials::OPTION, 'v1:not-base64!!', false );
		$this->assertNull( Tendr_Credentials::get( 'test' ) );
		$this->assertSame( 'unreadable', Tendr_Credentials::status() );
	}
}
