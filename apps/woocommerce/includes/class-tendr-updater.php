<?php
/**
 * Updates from usetendr.tech (spec §9), through the standard WordPress update hooks.
 *
 * The feed is `<checkout base>/v1/plugins/woocommerce/update.json`:
 * `{version, download_url, sha256, requires, tested, requires_php}`. An update is offered only when
 * the feed's version is greater than the installed one, and its package is a `.zip` on the feed's
 * own origin. Before WordPress installs it, `upgrader_pre_download` downloads the package to a
 * temporary file and checks its sha256 against the feed; on a mismatch the file is deleted and the
 * update stops. Nothing from the feed is ever run except through WordPress's normal update path.
 *
 * The feed must be https. A local origin (localhost, 127.0.0.1, [::1], host.docker.internal) over
 * http is accepted only when the site's environment type is not `production` (wp-env, the e2e).
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Plugin updates.
 */
final class Tendr_Updater {

	const SLUG       = 'tendr-pay-with-crypto';
	const FEED_PATH  = '/v1/plugins/woocommerce/update.json';
	const CACHE_KEY  = 'tendr_update_feed';
	const CACHE_TTL  = 6 * HOUR_IN_SECONDS;
	const ERROR_TTL  = HOUR_IN_SECONDS;
	const LOCAL      = array( 'localhost', '127.0.0.1', '[::1]', 'host.docker.internal' );
	const VERSION_RE = '/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/';

	/**
	 * Hook into the update checks, "View details" and the package download.
	 */
	public static function register(): void {
		add_filter( 'pre_set_site_transient_update_plugins', array( self::class, 'filter_update_plugins' ) );
		add_filter( 'plugins_api', array( self::class, 'filter_plugins_api' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( self::class, 'filter_pre_download' ), 10, 4 );
	}

	/**
	 * The feed URL for a checkout base, or null when that origin may not serve updates.
	 *
	 * @param string $base     Checkout base, e.g. `https://usetendr.tech`.
	 * @param string $env_type `wp_get_environment_type()`.
	 */
	public static function feed_url( string $base, string $env_type ): ?string {
		$parts = wp_parse_url( $base );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] ) ) {
			return null;
		}
		$scheme = strtolower( $parts['scheme'] );
		$host   = strtolower( $parts['host'] );
		if ( 'https' !== $scheme ) {
			$local = 'http' === $scheme && in_array( $host, self::LOCAL, true ) && 'production' !== $env_type;
			if ( ! $local ) {
				return null;
			}
		}
		return untrailingslashit( $base ) . self::FEED_PATH;
	}

	/**
	 * This site's feed URL, or null.
	 */
	private static function current_feed_url(): ?string {
		return self::feed_url( Tendr_Plugin::checkout_base(), wp_get_environment_type() );
	}

	/**
	 * Whether the feed is a local http origin (dev only): the requests then skip WordPress's
	 * "unsafe URL" check, which refuses local hosts.
	 *
	 * @param string $url Feed or package URL.
	 */
	private static function is_local_http( string $url ): bool {
		return 'http' === wp_parse_url( $url, PHP_URL_SCHEME );
	}

	/**
	 * Forget the cached feed (tests, and after an update).
	 */
	public static function forget(): void {
		delete_transient( self::CACHE_KEY );
	}

	/**
	 * The validated feed, cached; null when there is no release or the feed is unusable.
	 *
	 * @param bool $refresh Fetch even when cached.
	 * @return array{version: string, download_url: string, sha256: string, requires: string, tested: string, requires_php: string}|null
	 */
	public static function feed( bool $refresh = false ): ?array {
		$url = self::current_feed_url();
		if ( null === $url ) {
			return null;
		}
		$cached = $refresh ? false : get_transient( self::CACHE_KEY );
		if ( is_array( $cached ) && ( $cached['url'] ?? '' ) === $url ) {
			return $cached['feed'];
		}
		$feed = self::fetch( $url );
		set_transient(
			self::CACHE_KEY,
			array(
				'url'  => $url,
				'feed' => $feed,
			),
			null === $feed ? self::ERROR_TTL : self::CACHE_TTL
		);
		return $feed;
	}

	/**
	 * GET the feed and validate it.
	 *
	 * @param string $url Feed URL.
	 */
	private static function fetch( string $url ): ?array {
		$response = wp_remote_get(
			$url,
			array(
				'timeout'            => 10,
				'redirection'        => 0,
				'sslverify'          => true,
				'reject_unsafe_urls' => ! self::is_local_http( $url ),
				'user-agent'         => Tendr_Plugin::user_agent(),
				'headers'            => array( 'Accept' => 'application/json' ),
			)
		);
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return null;
		}
		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		return is_array( $body ) ? self::validate( $body, $url ) : null;
	}

	/**
	 * The feed's fields, or null when any is missing or unsafe.
	 *
	 * @param array  $body     Decoded JSON.
	 * @param string $feed_url Where it came from: the package must be on the same origin.
	 */
	public static function validate( array $body, string $feed_url ): ?array {
		$out = array();
		foreach ( array( 'version', 'download_url', 'sha256', 'requires', 'tested', 'requires_php' ) as $key ) {
			if ( ! isset( $body[ $key ] ) || ! is_string( $body[ $key ] ) || '' === $body[ $key ] || strlen( $body[ $key ] ) > 2048 ) {
				return null;
			}
			$out[ $key ] = $body[ $key ];
		}
		if ( ! preg_match( self::VERSION_RE, $out['version'] ) || ! preg_match( '/^[0-9a-f]{64}$/', $out['sha256'] ) ) {
			return null;
		}
		foreach ( array( 'requires', 'tested', 'requires_php' ) as $key ) {
			if ( ! preg_match( '/^\d+(\.\d+){0,2}$/', $out[ $key ] ) ) {
				return null;
			}
		}
		$package = wp_parse_url( $out['download_url'] );
		$feed    = wp_parse_url( $feed_url );
		if ( ! is_array( $package ) || ! is_array( $feed ) || isset( $package['user'] ) || isset( $package['pass'] ) || isset( $package['fragment'] ) ) {
			return null;
		}
		if ( self::origin( $package ) !== self::origin( $feed ) ) {
			return null;
		}
		if ( ! preg_match( '#^/downloads/woocommerce/[A-Za-z0-9][A-Za-z0-9._-]*\.zip$#', (string) ( $package['path'] ?? '' ) ) || isset( $package['query'] ) ) {
			return null;
		}
		return $out;
	}

	/**
	 * `scheme://host[:port]`, lower-cased.
	 *
	 * @param array $parts wp_parse_url() parts.
	 */
	private static function origin( array $parts ): string {
		$port = isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '';
		return strtolower( ( $parts['scheme'] ?? '' ) . '://' . ( $parts['host'] ?? '' ) ) . $port;
	}

	/**
	 * This plugin's `plugin_basename()`.
	 */
	private static function basename(): string {
		return plugin_basename( TENDR_PLUGIN_FILE );
	}

	/**
	 * The update entry WordPress shows for a feed.
	 *
	 * @param array $feed Validated feed.
	 */
	private static function entry( array $feed ): object {
		return (object) array(
			'id'           => self::basename(),
			'slug'         => self::SLUG,
			'plugin'       => self::basename(),
			'new_version'  => $feed['version'],
			'url'          => Tendr_Plugin::checkout_base() . '/downloads/woocommerce',
			'package'      => $feed['download_url'],
			'requires'     => $feed['requires'],
			'tested'       => $feed['tested'],
			'requires_php' => $feed['requires_php'],
		);
	}

	/**
	 * `pre_set_site_transient_update_plugins`: offer the feed's version when it is newer.
	 *
	 * @param mixed $transient The update_plugins value being saved.
	 * @return mixed
	 */
	public static function filter_update_plugins( $transient ) {
		if ( ! is_object( $transient ) || empty( $transient->checked ) ) {
			return $transient;
		}
		$feed = self::feed();
		if ( null === $feed ) {
			return $transient;
		}
		$basename = self::basename();
		$entry    = self::entry( $feed );
		if ( version_compare( $feed['version'], TENDR_VERSION, '>' ) ) {
			$transient->response              = isset( $transient->response ) && is_array( $transient->response ) ? $transient->response : array();
			$transient->response[ $basename ] = $entry;
			if ( isset( $transient->no_update[ $basename ] ) ) {
				unset( $transient->no_update[ $basename ] );
			}
		} else {
			$entry->new_version                = TENDR_VERSION;
			$transient->no_update              = isset( $transient->no_update ) && is_array( $transient->no_update ) ? $transient->no_update : array();
			$transient->no_update[ $basename ] = $entry;
			if ( isset( $transient->response[ $basename ] ) ) {
				unset( $transient->response[ $basename ] );
			}
		}
		return $transient;
	}

	/**
	 * `plugins_api`: "View details" for this plugin.
	 *
	 * @param false|object|array $result Earlier answer.
	 * @param string             $action The API action.
	 * @param object             $args   Request args (slug).
	 * @return false|object|array
	 */
	public static function filter_plugins_api( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || ! is_object( $args ) || ( $args->slug ?? '' ) !== self::SLUG ) {
			return $result;
		}
		$feed = self::feed();
		if ( null === $feed ) {
			return $result;
		}
		return (object) array(
			'name'          => 'tendr: Pay with crypto',
			'slug'          => self::SLUG,
			'version'       => $feed['version'],
			'author'        => 'tendr',
			'homepage'      => Tendr_Plugin::checkout_base() . '/downloads/woocommerce',
			'download_link' => $feed['download_url'],
			'requires'      => $feed['requires'],
			'tested'        => $feed['tested'],
			'requires_php'  => $feed['requires_php'],
			'sections'      => array(
				'description' => esc_html__( 'Take crypto payments in WooCommerce. They settle into your own tendr account.', 'tendr' ),
				'changelog'   => esc_html__( 'See the release notes on usetendr.tech.', 'tendr' ),
			),
		);
	}

	/**
	 * `upgrader_pre_download`: download this plugin's package and check its sha256 first.
	 *
	 * Returns the verified temporary file (WordPress then installs it), a WP_Error that stops the
	 * update, or `$reply` untouched for anything that is not this plugin's update.
	 *
	 * @param false|string|WP_Error $reply      Earlier answer.
	 * @param string                $package    Package URL.
	 * @param mixed                 $upgrader   WP_Upgrader.
	 * @param array                 $hook_extra Upgrade context.
	 * @return false|string|WP_Error
	 */
	public static function filter_pre_download( $reply, $package, $upgrader = null, $hook_extra = array() ) {
		if ( false !== $reply ) {
			return $reply;
		}
		$package = (string) $package;
		$ours    = is_array( $hook_extra ) && ( $hook_extra['plugin'] ?? '' ) === self::basename();
		if ( ! $ours ) {
			return $reply;
		}
		$feed = self::feed( true );
		if ( null === $feed || ! hash_equals( $feed['download_url'], $package ) ) {
			return new WP_Error( 'tendr_package_unknown', __( 'This tendr update is not the one usetendr.tech published. Try again later.', 'tendr' ) );
		}
		$file = wp_tempnam( 'tendr-update.zip' );
		if ( ! $file ) {
			return new WP_Error( 'tendr_download_failed', __( 'Could not create a temporary file for the tendr update.', 'tendr' ) );
		}
		$response = wp_remote_get(
			$package,
			array(
				'timeout'            => 300,
				'stream'             => true,
				'filename'           => $file,
				'redirection'        => 0,
				'sslverify'          => true,
				'reject_unsafe_urls' => ! self::is_local_http( $package ),
				'user-agent'         => Tendr_Plugin::user_agent(),
			)
		);
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			wp_delete_file( $file );
			return new WP_Error( 'tendr_download_failed', __( 'The tendr update could not be downloaded. Try again later.', 'tendr' ) );
		}
		$actual = hash_file( 'sha256', $file );
		if ( ! is_string( $actual ) || ! hash_equals( $feed['sha256'], $actual ) ) {
			wp_delete_file( $file );
			return new WP_Error( 'tendr_checksum_mismatch', __( 'The tendr update did not match its published checksum, so it was not installed.', 'tendr' ) );
		}
		return $file;
	}
}
