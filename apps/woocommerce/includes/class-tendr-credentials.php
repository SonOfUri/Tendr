<?php
/**
 * The connection's secrets, encrypted at rest in the options table.
 *
 * Encryption is libsodium secretbox (XSalsa20-Poly1305) under a key derived from the site's
 * AUTH_KEY and SECURE_AUTH_KEY salts. Anyone who can read both the database and wp-config.php can
 * decrypt them: that is the standard WordPress limit for stored credentials. If the salts change,
 * the stored value no longer decrypts and the site reads as disconnected ("Reconnect to tendr").
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Encrypted credential storage.
 */
final class Tendr_Credentials {

	const OPTION = 'tendr_credentials';

	/** Value format version. */
	const PREFIX = 'v1:';

	/** BLAKE2b key (16–64 bytes) separating this use of the salts from any other. */
	const CONTEXT = 'tendr-credentials-v1';

	const MODES  = array( 'test', 'live' );
	const FIELDS = array( 'secret_key', 'publishable_key', 'webhook_secret' );

	/**
	 * Store the credentials from a `POST /v1/connect/token` response, replacing any stored ones.
	 *
	 * @param array $issued The token response (`test` and `live`, each with the three FIELDS).
	 * @throws InvalidArgumentException When a mode or field is missing.
	 */
	public static function store( array $issued ): void {
		$clean = array();
		foreach ( self::MODES as $mode ) {
			foreach ( self::FIELDS as $field ) {
				$value = $issued[ $mode ][ $field ] ?? null;
				if ( ! is_string( $value ) || '' === $value ) {
					throw new InvalidArgumentException( 'Incomplete tendr credentials.' );
				}
				$clean[ $mode ][ $field ] = $value;
			}
		}
		$plain = (string) wp_json_encode( $clean );
		$value = self::seal( $plain, self::key() );
		if ( function_exists( 'sodium_memzero' ) ) {
			sodium_memzero( $plain );
		}
		update_option( self::OPTION, $value, false );
	}

	/**
	 * One mode's credentials (`secret_key`, `publishable_key`, `webhook_secret`), or null when none
	 * are stored or they cannot be decrypted.
	 *
	 * @param string $mode 'test' or 'live'.
	 */
	public static function get( string $mode ): ?array {
		if ( ! in_array( $mode, self::MODES, true ) ) {
			return null;
		}
		$all = self::read();
		return is_array( $all ) ? $all[ $mode ] : null;
	}

	/**
	 * 'none' (nothing stored), 'ok', or 'unreadable' (stored but cannot be decrypted, e.g. the
	 * salts changed).
	 */
	public static function status(): string {
		$all = self::read();
		if ( is_array( $all ) ) {
			return 'ok';
		}
		return false === $all ? 'none' : 'unreadable';
	}

	/**
	 * Delete the stored credentials.
	 */
	public static function clear(): void {
		delete_option( self::OPTION );
	}

	/**
	 * Encrypt `$plaintext` under `$key` into the stored format.
	 *
	 * @param string $plaintext Plaintext.
	 * @param string $key       SODIUM_CRYPTO_SECRETBOX_KEYBYTES bytes.
	 */
	public static function seal( string $plaintext, string $key ): string {
		$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		return self::PREFIX . base64_encode( $nonce . sodium_crypto_secretbox( $plaintext, $nonce, $key ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- binary ciphertext in a text option.
	}

	/**
	 * The decrypted credentials; false when nothing is stored; null when unreadable.
	 *
	 * @return array|false|null
	 */
	private static function read() {
		$stored = get_option( self::OPTION, false );
		if ( false === $stored || '' === $stored ) {
			return false;
		}
		if ( ! is_string( $stored ) || ! str_starts_with( $stored, self::PREFIX ) ) {
			return null;
		}
		$raw = base64_decode( substr( $stored, strlen( self::PREFIX ) ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES ) {
			return null;
		}
		try {
			$plain = sodium_crypto_secretbox_open(
				substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ),
				substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ),
				self::key()
			);
		} catch ( SodiumException $e ) {
			return null;
		}
		if ( false === $plain ) {
			return null;
		}
		$data = json_decode( $plain, true );
		if ( ! is_array( $data ) ) {
			return null;
		}
		foreach ( self::MODES as $mode ) {
			foreach ( self::FIELDS as $field ) {
				if ( ! isset( $data[ $mode ][ $field ] ) || ! is_string( $data[ $mode ][ $field ] ) ) {
					return null;
				}
			}
		}
		return $data;
	}

	/**
	 * The encryption key: BLAKE2b of AUTH_KEY . SECURE_AUTH_KEY, keyed with CONTEXT. Falls back to
	 * WordPress's database-stored salts when the constants are missing.
	 */
	private static function key(): string {
		$auth   = defined( 'AUTH_KEY' ) ? (string) AUTH_KEY : '';
		$secure = defined( 'SECURE_AUTH_KEY' ) ? (string) SECURE_AUTH_KEY : '';
		if ( '' === $auth || '' === $secure ) {
			$auth   = wp_salt( 'auth' );
			$secure = wp_salt( 'secure_auth' );
		}
		return sodium_crypto_generichash( $auth . $secure, self::CONTEXT, SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
	}
}
