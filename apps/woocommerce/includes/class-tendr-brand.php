<?php
/**
 * The store's look, sent to tendr so a themed checkout can start from it: site name, logo, icon
 * and the theme's colour palette (`PUT /v1/connection/brand`). tendr fetches the images itself;
 * only https URLs are sent. A failure never blocks Connect.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Brand sync.
 */
final class Tendr_Brand {

	const NONCE      = 'tendr_refresh_brand';
	const ACTION     = 'tendr_refresh_brand';
	const MAX_COLORS = 12;

	/**
	 * Register the settings-page button's handler.
	 */
	public static function register(): void {
		add_action( 'admin_post_' . self::ACTION, array( self::class, 'handle_refresh_request' ) );
	}

	/**
	 * What the store looks like: `site_name`, `logo_url` and `icon_url` when the store has an https
	 * one, and `palette` (up to 12 `#rrggbb` colours, empty when the theme has none).
	 *
	 * @return array{site_name?: string, logo_url?: string, icon_url?: string, palette: string[]}
	 */
	public static function collect(): array {
		$brand     = array();
		$site_name = mb_substr( trim( wp_strip_all_tags( (string) get_bloginfo( 'name' ) ) ), 0, 120 );
		if ( '' !== $site_name ) {
			$brand['site_name'] = $site_name;
		}

		$logo_id = (int) get_theme_mod( 'custom_logo' );
		$logo    = $logo_id > 0 ? wp_get_attachment_image_url( $logo_id, 'full' ) : false;
		if ( self::is_https_url( $logo ) ) {
			$brand['logo_url'] = (string) $logo;
		}
		$icon = function_exists( 'get_site_icon_url' ) ? get_site_icon_url( 512 ) : '';
		if ( self::is_https_url( $icon ) ) {
			$brand['icon_url'] = (string) $icon;
		}

		$brand['palette'] = self::palette();
		return $brand;
	}

	/**
	 * The theme's palette colours as `#rrggbb` (WordPress 5.9+; empty before, or when the theme
	 * has none). Colours that are not plain hex (gradients, `var()`, `rgb()`) are left out.
	 *
	 * @return string[]
	 */
	private static function palette(): array {
		if ( ! function_exists( 'wp_get_global_settings' ) ) {
			return array();
		}
		$entries = wp_get_global_settings( array( 'color', 'palette', 'theme' ) );
		$colors  = array();
		foreach ( is_array( $entries ) ? $entries : array() as $entry ) {
			$value = ( is_array( $entry ) && isset( $entry['color'] ) && is_string( $entry['color'] ) ) ? strtolower( trim( $entry['color'] ) ) : '';
			if ( preg_match( '/^#([0-9a-f])([0-9a-f])([0-9a-f])$/', $value, $m ) ) {
				$value = '#' . $m[1] . $m[1] . $m[2] . $m[2] . $m[3] . $m[3];
			}
			if ( 1 === preg_match( '/^#[0-9a-f]{6}$/', $value ) && ! in_array( $value, $colors, true ) ) {
				$colors[] = $value;
			}
			if ( count( $colors ) >= self::MAX_COLORS ) {
				break;
			}
		}
		return $colors;
	}

	/**
	 * Whether a value is an https URL tendr can fetch.
	 *
	 * @param mixed $url Candidate.
	 */
	public static function is_https_url( $url ): bool {
		return is_string( $url ) && strlen( $url ) <= 2048 && str_starts_with( $url, 'https://' ) && false !== filter_var( $url, FILTER_VALIDATE_URL ) && is_string( wp_parse_url( $url, PHP_URL_HOST ) );
	}

	/**
	 * `PUT /v1/connection/brand` with the connection's key.
	 *
	 * @param string|null $mode 'test' | 'live' (default: the current mode).
	 * @return array|WP_Error
	 */
	public static function send( ?string $mode = null ) {
		return Tendr_Api_Client::request( 'PUT', '/v1/connection/brand', self::collect(), $mode ?? Tendr_Connect::mode() );
	}

	/**
	 * Send the brand and leave a notice for the settings page: success, or the reason it failed.
	 *
	 * @return bool Whether tendr took it.
	 */
	public static function refresh(): bool {
		$result = self::send();
		if ( is_wp_error( $result ) ) {
			Tendr_Settings::flash( 'warning', __( 'Could not send your store\'s look to tendr:', 'tendr-pay-with-crypto' ) . ' ' . $result->get_error_message() );
			return false;
		}
		Tendr_Settings::flash( 'success', __( 'Your store\'s name, logo and colours were sent to tendr.', 'tendr-pay-with-crypto' ) );
		return true;
	}

	/**
	 * Right after Connect: send the brand, and on failure only leave a notice for the next
	 * settings page load (the connection is already saved and works without it).
	 */
	public static function send_after_connect(): void {
		$result = self::send();
		if ( is_wp_error( $result ) ) {
			Tendr_Settings::flash( 'warning', __( 'Connected, but your store\'s look could not be sent to tendr yet. Use "Refresh brand from my store" to try again.', 'tendr-pay-with-crypto' ) );
		}
	}

	/**
	 * `admin-post.php?action=tendr_refresh_brand` (POST, nonce, capability).
	 */
	public static function handle_refresh_request(): void {
		$nonce = isset( $_POST['tendr_brand_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_brand_nonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, self::NONCE ) || ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr-pay-with-crypto' ), 403 );
		}
		self::refresh();
		wp_safe_redirect( Tendr_Settings::url() );
		exit;
	}
}
