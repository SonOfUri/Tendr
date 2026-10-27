<?php
/**
 * One-click Connect: an authorization-code flow with PKCE (S256).
 *
 * 1. "Connect to tendr" opens a popup on `admin-post.php?action=tendr_connect_start`, which makes a
 *    state and a PKCE verifier (kept 60 minutes in a transient keyed by the state, bound to the
 *    admin) and redirects to `<checkout base>/connect`.
 * 2. tendr returns the popup to `return_url` — the admin page `admin.php?page=tendr-connect-callback`,
 *    authenticated by the admin's own login cookie — with `code` and `state`, or
 *    `error=access_denied` and `state` when the person cancels.
 * 3. The callback checks the state, exchanges the code server to server (`POST /v1/connect/token`),
 *    stores the credentials encrypted, turns the gateway on in test mode, then closes the popup and
 *    reloads the settings page.
 *
 * `return_url` must be on the same origin as the home URL (tendr checks it), so Connect is blocked
 * on sites whose admin lives on another origin than the site. The webhook URL tendr registers is
 * `<home>/wp-json/tendr/v1/webhook`, so Connect is also blocked unless the REST API is served there
 * (pretty permalinks on, the default `wp-json` prefix).
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Connect and disconnect.
 */
final class Tendr_Connect {

	const CALLBACK_PAGE    = 'tendr-connect-callback';
	const TRANSIENT_PREFIX = 'tendr_connect_';
	const STATE_TTL        = 60 * MINUTE_IN_SECONDS;
	const CONNECTION       = 'tendr_connection';
	const MODE             = 'tendr_mode';
	const GATEWAY_SETTINGS = 'woocommerce_tendr_settings';
	const WEBHOOK_ROUTE    = 'tendr/v1/webhook';
	const SITE_ID          = 'tendr_site_id';

	/**
	 * Register the admin page, the admin-post actions and the redirect allowance.
	 */
	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'add_callback_page' ) );
		add_action( 'admin_post_tendr_connect_start', array( self::class, 'handle_start_request' ) );
		add_action( 'admin_post_tendr_disconnect', array( self::class, 'handle_disconnect_request' ) );
	}

	/**
	 * The callback page: registered without a menu entry; rendered as a bare page on load.
	 */
	public static function add_callback_page(): void {
		$hook = add_submenu_page(
			'',
			__( 'Connecting to tendr', 'tendr' ),
			'',
			'manage_woocommerce',
			self::CALLBACK_PAGE,
			'__return_null'
		);
		if ( $hook ) {
			add_action( 'load-' . $hook, array( self::class, 'handle_callback_request' ) );
		}
	}

	/**
	 * The popup's first stop: make the state and verifier, then go to tendr.
	 */
	public static function handle_start_request(): void {
		$nonce = isset( $_GET['_wpnonce'] ) ? sanitize_text_field( wp_unslash( $_GET['_wpnonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, 'tendr_connect_start' ) ) {
			wp_die( esc_html__( 'This Connect link has expired. Close this window and click Connect again.', 'tendr' ), 403 );
		}
		$url = self::start();
		if ( is_wp_error( $url ) ) {
			wp_die( esc_html( $url->get_error_message() ), 403 );
		}
		$host = (string) wp_parse_url( $url, PHP_URL_HOST );
		add_filter(
			'allowed_redirect_hosts',
			static function ( $hosts ) use ( $host ) {
				$hosts[] = $host;
				return $hosts;
			}
		);
		nocache_headers();
		wp_safe_redirect( $url );
		exit;
	}

	/**
	 * The callback page's load hook: handle the return and print the bare popup page.
	 */
	public static function handle_callback_request(): void {
		$params = array();
		foreach ( array( 'state', 'code', 'error' ) as $name ) {
			// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the single-use state, bound to this admin, is the CSRF check.
			if ( isset( $_GET[ $name ] ) && is_string( $_GET[ $name ] ) ) {
				// phpcs:ignore WordPress.Security.NonceVerification.Recommended
				$params[ $name ] = sanitize_text_field( wp_unslash( $_GET[ $name ] ) );
			}
		}
		$result = self::handle_callback( $params );
		// Shown on the settings page the popup reloads.
		$type = array(
			'connected' => 'success',
			'cancelled' => 'info',
		);
		Tendr_Settings::flash( $type[ $result['status'] ] ?? 'error', $result['message'] );
		nocache_headers();
		header( 'Content-Type: text/html; charset=utf-8' );
		header( 'Referrer-Policy: no-referrer' );
		echo self::render_callback_page( $result ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in render_callback_page().
		exit;
	}

	/**
	 * Disconnect from the settings page.
	 */
	public static function handle_disconnect_request(): void {
		$nonce = isset( $_GET['_wpnonce'] ) ? sanitize_text_field( wp_unslash( $_GET['_wpnonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, 'tendr_disconnect' ) || ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr' ), 403 );
		}
		self::disconnect();
		wp_safe_redirect( Tendr_Settings::url() );
		exit;
	}

	/**
	 * Why Connect cannot run on this site, or null when it can. Capabilities are checked separately.
	 */
	public static function blocker(): ?WP_Error {
		$home = untrailingslashit( home_url() );
		if ( self::origin_of( admin_url() ) !== self::origin_of( $home ) ) {
			return new WP_Error(
				'tendr_admin_origin',
				sprintf(
					/* translators: 1: the WordPress admin address, 2: the site address. */
					__( 'Connect needs the WordPress admin (%1$s) on the same address as the site (%2$s). Set the WordPress Address and Site Address to the same origin under Settings → General.', 'tendr' ),
					self::origin_of( admin_url() ),
					self::origin_of( $home )
				)
			);
		}
		global $wp_rewrite;
		$structure = (string) get_option( 'permalink_structure' );
		if ( '' === $structure || ( $wp_rewrite instanceof WP_Rewrite && $wp_rewrite->using_index_permalinks() ) ) {
			return new WP_Error(
				'tendr_permalinks',
				__( 'Enable pretty permalinks to connect. tendr sends payment updates to /wp-json/tendr/v1/webhook, which needs a permalink structure other than Plain (Settings → Permalinks).', 'tendr' )
			);
		}
		if ( 'wp-json' !== rest_get_url_prefix() ) {
			return new WP_Error(
				'tendr_rest_prefix',
				__( 'tendr sends payment updates to /wp-json/tendr/v1/webhook, but this site serves its REST API under another prefix. Remove the custom REST prefix to connect.', 'tendr' )
			);
		}
		$expected = self::strip_scheme( $home . '/wp-json/' . self::WEBHOOK_ROUTE );
		if ( self::strip_scheme( untrailingslashit( rest_url( self::WEBHOOK_ROUTE ) ) ) !== $expected ) {
			return new WP_Error(
				'tendr_rest_url',
				__( 'tendr sends payment updates to /wp-json/tendr/v1/webhook below the site address, but this site serves its REST API elsewhere. Check the permalink and REST API settings.', 'tendr' )
			);
		}
		return null;
	}

	/**
	 * Start Connect: the popup URL on tendr, or why it cannot start.
	 *
	 * @return string|WP_Error
	 */
	public static function start() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return new WP_Error( 'tendr_forbidden', __( 'You need permission to manage WooCommerce to connect tendr.', 'tendr' ) );
		}
		$blocked = self::blocker();
		if ( null !== $blocked ) {
			return $blocked;
		}

		$state     = self::base64url( random_bytes( 32 ) );
		$verifier  = self::base64url( random_bytes( 64 ) );
		$challenge = self::base64url( hash( 'sha256', $verifier, true ) );
		$site_url  = untrailingslashit( home_url() );

		set_transient(
			self::transient_key( $state ),
			array(
				'verifier' => $verifier,
				'user_id'  => get_current_user_id(),
				'site_url' => $site_url,
			),
			self::STATE_TTL
		);

		$query = array(
			'site_url'              => $site_url,
			'return_url'            => self::return_url(),
			'state'                 => $state,
			'code_challenge'        => $challenge,
			'code_challenge_method' => 'S256',
			'platform'              => 'woocommerce',
			'plugin_version'        => TENDR_VERSION,
		);
		return Tendr_Plugin::checkout_base() . '/connect?' . http_build_query( $query, '', '&', PHP_QUERY_RFC3986 );
	}

	/**
	 * Where tendr sends the popup back: the callback admin page (no fragment).
	 */
	public static function return_url(): string {
		return admin_url( 'admin.php?page=' . self::CALLBACK_PAGE );
	}

	/**
	 * The transient key for a state.
	 *
	 * @param string $state The state.
	 */
	public static function transient_key( string $state ): string {
		return self::TRANSIENT_PREFIX . hash( 'sha256', $state );
	}

	/**
	 * Handle the popup's return.
	 *
	 * @param array $params `state` and either `code` or `error`.
	 * @return array{status: string, message: string} status is connected, cancelled or error.
	 */
	public static function handle_callback( array $params ): array {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return self::result( 'error', __( 'You need permission to manage WooCommerce to connect tendr.', 'tendr' ) );
		}

		$state   = ( isset( $params['state'] ) && is_string( $params['state'] ) ) ? $params['state'] : '';
		$pending = ( '' !== $state && strlen( $state ) <= 512 ) ? get_transient( self::transient_key( $state ) ) : false;
		if ( ! is_array( $pending ) || (int) ( $pending['user_id'] ?? 0 ) !== get_current_user_id() || empty( $pending['verifier'] ) ) {
			return self::result( 'error', __( 'This connection attempt has expired or was started by someone else. Close this window and click Connect again.', 'tendr' ) );
		}
		delete_transient( self::transient_key( $state ) );

		if ( isset( $params['error'] ) ) {
			if ( 'access_denied' === $params['error'] ) {
				return self::result( 'cancelled', __( 'Connection cancelled', 'tendr' ) );
			}
			return self::result( 'error', __( 'Connection failed. Close this window and click Connect again.', 'tendr' ) );
		}

		$code = ( isset( $params['code'] ) && is_string( $params['code'] ) ) ? $params['code'] : '';
		if ( '' === $code || strlen( $code ) > 200 ) {
			return self::result( 'error', __( 'Connection failed. Close this window and click Connect again.', 'tendr' ) );
		}

		$issued = Tendr_Api_Client::request_public(
			'POST',
			'/v1/connect/token',
			array(
				'code'          => $code,
				'code_verifier' => (string) $pending['verifier'],
				'site_url'      => (string) $pending['site_url'],
			)
		);
		if ( is_wp_error( $issued ) ) {
			$message = 'tendr_unreachable' === $issued->get_error_code()
				? $issued->get_error_message()
				: __( 'tendr could not complete the connection. Close this window and click Connect again.', 'tendr' );
			return self::result( 'error', $message );
		}

		try {
			self::save_connection( $issued, (string) $pending['site_url'] );
		} catch ( InvalidArgumentException $e ) {
			return self::result( 'error', __( 'tendr sent a response this plugin could not read. Close this window and click Connect again.', 'tendr' ) );
		}

		/* translators: %s: the tendr store name. */
		return self::result( 'connected', sprintf( __( 'Connected to %s', 'tendr' ), $issued['store']['name'] ) );
	}

	/**
	 * Save a token response: encrypted credentials, the public connection details, test mode, and
	 * the gateway turned on. Replaces any earlier connection.
	 *
	 * @param array  $issued   The token response.
	 * @param string $site_url The site URL it was issued for.
	 * @throws InvalidArgumentException When the response is incomplete.
	 */
	public static function save_connection( array $issued, string $site_url ): void {
		$store = ( isset( $issued['store'] ) && is_array( $issued['store'] ) ) ? $issued['store'] : array();
		foreach ( array( $issued['connection_id'] ?? null, $store['id'] ?? null, $store['name'] ?? null ) as $value ) {
			if ( ! is_string( $value ) || '' === $value ) {
				throw new InvalidArgumentException( 'Incomplete tendr connection.' );
			}
		}
		Tendr_Credentials::store( $issued );
		// Made at the first Connect; order refs hash it (never the site address).
		self::site_id();

		update_option(
			self::CONNECTION,
			array(
				'id'           => $issued['connection_id'],
				'store_id'     => $store['id'],
				'store_name'   => $store['name'],
				'test_account' => is_string( $store['test_account'] ?? null ) ? $store['test_account'] : '',
				'live_account' => is_string( $store['live_account'] ?? null ) ? $store['live_account'] : '',
				'site_url'     => $site_url,
				'connected_at' => time(),
			),
			false
		);
		update_option( self::MODE, 'test' );
		self::set_gateway_enabled( true );
	}

	/**
	 * Disconnect: revoke this site's keys on tendr, then forget them here even if tendr could not be
	 * reached. The outcome is shown on the settings page.
	 */
	public static function disconnect(): void {
		$api = 'skipped';
		if ( 'ok' === Tendr_Credentials::status() ) {
			$response = Tendr_Api_Client::request( 'POST', '/v1/connect/disconnect', array(), self::mode() );
			if ( ! is_wp_error( $response ) ) {
				$api = 'revoked';
			} else {
				$status = (int) ( $response->get_error_data()['status'] ?? 0 );
				// A key that is already revoked answers 401: nothing left to revoke.
				$api = 401 === $status ? 'revoked' : 'failed';
			}
		}

		Tendr_Credentials::clear();
		delete_option( self::CONNECTION );
		update_option( self::MODE, 'test' );
		self::set_gateway_enabled( false );

		if ( 'revoked' === $api ) {
			Tendr_Settings::flash( 'success', __( 'Disconnected from tendr. This site\'s keys are revoked.', 'tendr' ) );
		} elseif ( 'failed' === $api ) {
			Tendr_Settings::flash( 'warning', __( 'Disconnected on this site, but this site could not reach tendr to revoke its keys. Remove it under Settings → Connected sites on your tendr dashboard.', 'tendr' ) );
		} else {
			Tendr_Settings::flash( 'warning', __( 'Disconnected on this site. Its stored keys could not be read, so remove it under Settings → Connected sites on your tendr dashboard to revoke them.', 'tendr' ) );
		}
	}

	/**
	 * This site's id for order refs: 32 random hex characters, made once and kept (it survives
	 * Disconnect and re-Connect), so a ref never depends on the site address.
	 */
	public static function site_id(): string {
		$id = get_option( self::SITE_ID );
		if ( is_string( $id ) && 1 === preg_match( '/^[0-9a-f]{32}$/', $id ) ) {
			return $id;
		}
		$id = bin2hex( random_bytes( 16 ) );
		if ( ! add_option( self::SITE_ID, $id, '', false ) ) {
			// Another request made it first, or an unusable value is stored: keep a valid one.
			$stored = get_option( self::SITE_ID );
			if ( is_string( $stored ) && 1 === preg_match( '/^[0-9a-f]{32}$/', $stored ) ) {
				return $stored;
			}
			update_option( self::SITE_ID, $id, false );
		}
		return $id;
	}

	/**
	 * The public connection details (no secrets), or null.
	 */
	public static function connection(): ?array {
		$connection = get_option( self::CONNECTION );
		return ( is_array( $connection ) && ! empty( $connection['id'] ) ) ? $connection : null;
	}

	/**
	 * Whether the site holds a connection whose credentials can be read.
	 */
	public static function is_connected(): bool {
		return null !== self::connection() && 'ok' === Tendr_Credentials::status();
	}

	/**
	 * The current mode: 'test' or 'live'.
	 */
	public static function mode(): string {
		return 'live' === get_option( self::MODE ) ? 'live' : 'test';
	}

	/**
	 * The bare page the popup lands on: tells the settings page, then closes itself.
	 *
	 * @param array $result From handle_callback().
	 */
	public static function render_callback_page( array $result ): string {
		$status  = in_array( $result['status'] ?? '', array( 'connected', 'cancelled', 'error' ), true ) ? $result['status'] : 'error';
		$message = (string) ( $result['message'] ?? '' );

		$script = sprintf(
			'(function(){var m={source:"tendr-connect",status:%s};try{if(window.opener&&!window.opener.closed){window.opener.postMessage(m,window.location.origin);}}catch(e){}window.close();})();',
			wp_json_encode( $status )
		);

		return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
			. '<title>' . esc_html__( 'tendr', 'tendr' ) . '</title>'
			. '<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:48px 16px;text-align:center;color:#1d2327;background:#f6f7f7}a{color:#2271b1}</style>'
			. '</head><body>'
			. '<p><strong>' . esc_html( $message ) . '</strong></p>'
			. '<p>' . esc_html__( 'You can close this window.', 'tendr' ) . ' <a href="' . esc_url( Tendr_Settings::url() ) . '">' . esc_html__( 'Back to tendr settings', 'tendr' ) . '</a></p>'
			. wp_get_inline_script_tag( $script )
			. '</body></html>';
	}

	/**
	 * Turn the gateway's `enabled` setting on or off.
	 *
	 * @param bool $enabled On or off.
	 */
	private static function set_gateway_enabled( bool $enabled ): void {
		$settings            = get_option( self::GATEWAY_SETTINGS, array() );
		$settings            = is_array( $settings ) ? $settings : array();
		$settings['enabled'] = $enabled ? 'yes' : 'no';
		update_option( self::GATEWAY_SETTINGS, $settings );
	}

	/**
	 * A callback result.
	 *
	 * @param string $status  connected, cancelled or error.
	 * @param string $message Shown to the admin.
	 */
	private static function result( string $status, string $message ): array {
		return array(
			'status'  => $status,
			'message' => $message,
		);
	}

	/**
	 * Base64url without padding.
	 *
	 * @param string $bytes Bytes.
	 */
	private static function base64url( string $bytes ): string {
		return rtrim( strtr( base64_encode( $bytes ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- PKCE encoding.
	}

	/**
	 * `scheme://host[:port]` of a URL, lower-cased.
	 *
	 * @param string $url URL.
	 */
	private static function origin_of( string $url ): string {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] ?? 'http' );
		$port   = isset( $parts['port'] ) ? ':' . $parts['port'] : '';
		return $scheme . '://' . strtolower( $parts['host'] ) . $port;
	}

	/**
	 * A URL without its scheme.
	 *
	 * @param string $url URL.
	 */
	private static function strip_scheme( string $url ): string {
		return (string) preg_replace( '#^[a-z][a-z0-9+.\-]*:#i', '', $url );
	}
}
