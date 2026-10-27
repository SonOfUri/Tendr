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
		$html = self::callback_page_for_request();
		nocache_headers();
		header( 'Content-Type: text/html; charset=utf-8' );
		header( 'Referrer-Policy: no-referrer' );
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in render_callback_page().
		exit;
	}

	/**
	 * The callback request: handle the return from tendr (its `state`, `code`, `error` query
	 * arguments), flash the result for the settings page the popup reloads, and return the popup
	 * page's HTML.
	 */
	public static function callback_page_for_request(): string {
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
		if ( isset( $result['notice'] ) ) {
			Tendr_Settings::flash( 'warning', $result['message'] . ' ' . $result['notice'] );
		} else {
			Tendr_Settings::flash( $type[ $result['status'] ] ?? 'error', $result['message'] );
		}
		return self::render_callback_page( $result );
	}

	/**
	 * Disconnect from the settings page (a POST of the settings form, never a link).
	 */
	public static function handle_disconnect_request(): void {
		if ( ! self::disconnect_from_request() ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr' ), 403 );
		}
		wp_safe_redirect( Tendr_Settings::url() );
		exit;
	}

	/**
	 * Disconnect when the request is a POST carrying the `tendr_disconnect` nonce from a store
	 * manager. Returns whether it did.
	 */
	public static function disconnect_from_request(): bool {
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) ) : '';
		$nonce  = isset( $_POST['tendr_disconnect_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_disconnect_nonce'] ) ) : '';
		if ( 'POST' !== $method || ! wp_verify_nonce( $nonce, 'tendr_disconnect' ) || ! current_user_can( 'manage_woocommerce' ) ) {
			return false;
		}
		self::disconnect();
		return true;
	}

	/**
	 * Why Connect cannot run on this site, or null when it can. Capabilities are checked separately.
	 */
	public static function blocker(): ?WP_Error {
		$salts = Tendr_Credentials::site_salt_problem();
		if ( null !== $salts ) {
			return new WP_Error( 'tendr_salts', Tendr_Credentials::salt_message( $salts ) );
		}
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
		// C1: never take credentials this site cannot keep secret (the code is left unredeemed).
		$salts = Tendr_Credentials::site_salt_problem();
		if ( null !== $salts ) {
			return self::result( 'error', Tendr_Credentials::salt_message( $salts ) );
		}

		// A3: the connection this site holds now, kept until the new one is stored, then handed over.
		$previous = self::is_connected() ? self::connection() : null;
		$old_keys = array();
		if ( null !== $previous ) {
			foreach ( Tendr_Credentials::MODES as $mode ) {
				$held = Tendr_Credentials::get( $mode );
				if ( null !== $held ) {
					$old_keys[ $mode ] = $held['secret_key'];
				}
			}
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
		$result = self::result( 'connected', sprintf( __( 'Connected to %s', 'tendr' ), $issued['store']['name'] ) );
		if ( null !== $previous && $previous['id'] !== $issued['connection_id'] && ! self::replace_previous( $old_keys, (string) $issued['connection_id'] ) ) {
			$result['notice'] = __( 'tendr could not move this site\'s earlier connection to the new one, so payments and refunds for orders placed before you reconnected may not update here. Check those orders on your tendr dashboard.', 'tendr' );
		}
		return $result;
	}

	/**
	 * A3: after a re-connect (for example at a new site address, which tendr treats as a new
	 * site), hand the previous connection's orders to the new one: `POST /v1/connect/replace`
	 * authenticated with the previous connection's key. tendr then revokes it, sends webhooks for
	 * its orders here, and lets this connection refund them. 401 means there was nothing left to
	 * hand over (tendr already replaced it on a same-address re-connect, or it was removed). The
	 * old keys exist only in memory here and are forgotten after.
	 *
	 * @param array<string, string> $old_keys  The previous connection's secret keys by mode.
	 * @param string                $successor The new connection id.
	 * @return bool Whether the hand-over is done (or was not needed).
	 */
	private static function replace_previous( array $old_keys, string $successor ): bool {
		$done = array() === $old_keys;
		foreach ( $old_keys as $mode => $key ) {
			$result = Tendr_Api_Client::request_with_key( 'POST', '/v1/connect/replace', array( 'successor_connection_id' => $successor ), $key );
			if ( ! is_wp_error( $result ) || 401 === (int) ( $result->get_error_data()['status'] ?? 0 ) ) {
				$done = true;
				break;
			}
		}
		foreach ( array_keys( $old_keys ) as $mode ) {
			if ( function_exists( 'sodium_memzero' ) ) {
				sodium_memzero( $old_keys[ $mode ] );
			}
		}
		if ( ! $done && function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->warning( 'tendr re-connect: the previous connection could not be handed to the new one.', array( 'source' => 'tendr' ) );
		}
		return $done;
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

		// A4: tendr cancels their open checkouts; a deposit already on its way still lands, but its
		// outcome can no longer reach this site. Say so on each order still waiting.
		foreach ( self::open_orders() as $order ) {
			$order->add_order_note( __( 'tendr disconnected — a payment for this order will not be reported here; check the tendr dashboard.', 'tendr' ) );
		}

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
	 * Pending tendr orders that have a crypto checkout (a session), oldest first: the orders a
	 * Disconnect leaves without payment updates.
	 *
	 * @param int $limit At most this many.
	 * @return WC_Order[]
	 */
	public static function open_orders( int $limit = 500 ): array {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}
		$orders = wc_get_orders(
			array(
				'status'         => array( 'pending' ),
				'payment_method' => 'tendr',
				'limit'          => $limit,
				'orderby'        => 'date',
				'order'          => 'ASC',
			)
		);
		// Filtered here, not by a meta query: the legacy (posts) order store does not support one.
		return array_values(
			array_filter(
				is_array( $orders ) ? $orders : array(),
				static fn( $o ) => $o instanceof WC_Order && '' !== (string) $o->get_meta( '_tendr_session_id' )
			)
		);
	}

	/**
	 * How many orders open_orders() finds (for the Disconnect confirmation).
	 */
	public static function open_order_count(): int {
		return count( self::open_orders() );
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
