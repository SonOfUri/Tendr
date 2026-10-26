<?php
/**
 * The settings page body (WooCommerce → Settings → Payments → tendr), rendered by
 * Tendr_Gateway::admin_options(). It never prints a secret: only the store name, NEAR account
 * and mode.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Settings page.
 */
final class Tendr_Settings {

	const FLASH_PREFIX = 'tendr_notice_';

	/**
	 * Register the admin script.
	 */
	public static function register(): void {
		add_action( 'admin_enqueue_scripts', array( self::class, 'enqueue' ) );
	}

	/**
	 * The settings page URL.
	 */
	public static function url(): string {
		return admin_url( 'admin.php?page=wc-settings&tab=checkout&section=tendr' );
	}

	/**
	 * Enqueue the Connect popup script on the tendr settings section only.
	 */
	public static function enqueue(): void {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- reading which admin page is open.
		$page    = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : '';
		$section = isset( $_GET['section'] ) ? sanitize_key( wp_unslash( $_GET['section'] ) ) : '';
		// phpcs:enable
		if ( 'wc-settings' !== $page || 'tendr' !== $section ) {
			return;
		}
		wp_enqueue_script(
			'tendr-admin-connect',
			plugins_url( 'assets/js/admin-connect.js', TENDR_PLUGIN_FILE ),
			array(),
			TENDR_VERSION,
			true
		);
		wp_localize_script(
			'tendr-admin-connect',
			'tendrConnect',
			array(
				'cancelled' => __( 'Connection cancelled', 'tendr' ),
				'confirm'   => __( 'Disconnect this site from tendr? Its keys are revoked and it stops taking crypto payments.', 'tendr' ),
			)
		);
	}

	/**
	 * Show a one-time notice to the current user on the next settings page load.
	 *
	 * @param string $type    success, info, warning or error.
	 * @param string $message Plain text.
	 */
	public static function flash( string $type, string $message ): void {
		$user = get_current_user_id();
		if ( $user > 0 && '' !== $message ) {
			set_transient(
				self::FLASH_PREFIX . $user,
				array(
					'type'    => $type,
					'message' => $message,
				),
				5 * MINUTE_IN_SECONDS
			);
		}
	}

	/**
	 * The page body.
	 */
	public static function render(): string {
		$html  = '<h2>' . esc_html__( 'tendr: Pay with crypto', 'tendr' ) . '</h2>';
		$html .= self::take_flash();

		$connection = Tendr_Connect::connection();
		$status     = Tendr_Credentials::status();
		$blocker    = Tendr_Connect::blocker();

		if ( null !== $connection && 'ok' === $status ) {
			if ( null !== $blocker ) {
				$html .= self::notice( 'error', __( 'Payment updates cannot reach this site:', 'tendr' ) . ' ' . $blocker->get_error_message(), self::fix_link( $blocker ) );
			}
			return $html . self::connected( $connection );
		}

		if ( 'unreadable' === $status || null !== $connection ) {
			$html .= self::notice(
				'warning',
				__( 'Reconnect to tendr. This site\'s stored tendr keys can no longer be read (the WordPress security keys in wp-config.php changed), so it cannot take crypto payments until you reconnect.', 'tendr' )
			);
			$label = __( 'Reconnect to tendr', 'tendr' );
		} else {
			$html .= '<p>' . esc_html__( 'Connect this site to your tendr store to take crypto payments. You approve it on usetendr.tech, and there are no keys to copy.', 'tendr' ) . '</p>';
			$label = __( 'Connect to tendr', 'tendr' );
		}

		if ( null !== $blocker ) {
			$html .= self::notice( 'error', $blocker->get_error_message(), self::fix_link( $blocker ) );
			return $html . '<p><button type="button" class="button button-primary" disabled>' . esc_html( $label ) . '</button></p>';
		}

		$start = wp_nonce_url( admin_url( 'admin-post.php?action=tendr_connect_start' ), 'tendr_connect_start' );
		return $html
			. '<p><button type="button" class="button button-primary" data-tendr-connect="' . esc_url( $start ) . '">' . esc_html( $label ) . '</button>'
			. ' <span class="tendr-connect-status" role="status" aria-live="polite"></span></p>';
	}

	/**
	 * The connected state: store, account, mode, links, Disconnect.
	 *
	 * @param array $connection Public connection details.
	 */
	private static function connected( array $connection ): string {
		$dashboard  = Tendr_Plugin::checkout_base() . '/dashboard';
		$disconnect = wp_nonce_url( admin_url( 'admin-post.php?action=tendr_disconnect' ), 'tendr_disconnect' );
		$mode       = 'live' === Tendr_Connect::mode() ? __( 'Live mode', 'tendr' ) : __( 'Test mode', 'tendr' );

		$html  = '<p>' . esc_html__( 'Connected to', 'tendr' ) . ' <strong>' . esc_html( (string) $connection['store_name'] ) . '</strong></p>';
		$html .= '<table class="form-table" role="presentation"><tbody>';
		if ( '' !== (string) ( $connection['test_account'] ?? '' ) ) {
			$html .= '<tr><th scope="row">' . esc_html__( 'Test account', 'tendr' ) . '</th><td><code>' . esc_html( (string) $connection['test_account'] ) . '</code></td></tr>';
		}
		if ( '' !== (string) ( $connection['live_account'] ?? '' ) ) {
			$html .= '<tr><th scope="row">' . esc_html__( 'Live account', 'tendr' ) . '</th><td><code>' . esc_html( (string) $connection['live_account'] ) . '</code></td></tr>';
		}
		// The Test / Live switch and Go live arrive with the test purchase work.
		$html .= '<tr><th scope="row">' . esc_html__( 'Mode', 'tendr' ) . '</th><td><strong>' . esc_html( $mode ) . '</strong>'
			. '<p class="description">' . esc_html__( 'Payments are simulated in test mode. Going live arrives in a later update.', 'tendr' ) . '</p></td></tr>';
		$html .= '</tbody></table>';

		$html .= '<p>'
			. '<a class="button" href="' . esc_url( $dashboard ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Open tendr dashboard', 'tendr' ) . '</a> '
			. '<a class="button" href="' . esc_url( $dashboard . '/review' ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Review queue', 'tendr' ) . '</a> '
			. '<a class="button button-link-delete" data-tendr-disconnect href="' . esc_url( $disconnect ) . '">' . esc_html__( 'Disconnect', 'tendr' ) . '</a>'
			. '</p>';
		return $html;
	}

	/**
	 * Print and forget the current user's flash notice.
	 */
	private static function take_flash(): string {
		$user = get_current_user_id();
		if ( $user <= 0 ) {
			return '';
		}
		$flash = get_transient( self::FLASH_PREFIX . $user );
		if ( ! is_array( $flash ) || empty( $flash['message'] ) ) {
			return '';
		}
		delete_transient( self::FLASH_PREFIX . $user );
		return self::notice( (string) ( $flash['type'] ?? 'info' ), (string) $flash['message'] );
	}

	/**
	 * A link that fixes a Connect blocker, or ''.
	 *
	 * @param WP_Error $blocker From Tendr_Connect::blocker().
	 */
	private static function fix_link( WP_Error $blocker ): string {
		switch ( $blocker->get_error_code() ) {
			case 'tendr_permalinks':
				return '<a href="' . esc_url( admin_url( 'options-permalink.php' ) ) . '">' . esc_html__( 'Open permalink settings', 'tendr' ) . '</a>';
			case 'tendr_admin_origin':
				return '<a href="' . esc_url( admin_url( 'options-general.php' ) ) . '">' . esc_html__( 'Open general settings', 'tendr' ) . '</a>';
			default:
				return '';
		}
	}

	/**
	 * An inline admin notice.
	 *
	 * @param string $type    success, info, warning or error.
	 * @param string $message Plain text.
	 * @param string $extra   Already-escaped HTML appended to the message.
	 */
	private static function notice( string $type, string $message, string $extra = '' ): string {
		$type = in_array( $type, array( 'success', 'info', 'warning', 'error' ), true ) ? $type : 'info';
		return '<div class="notice notice-' . esc_attr( $type ) . ' inline"><p>' . esc_html( $message ) . ( '' !== $extra ? ' ' . $extra : '' ) . '</p></div>';
	}
}
