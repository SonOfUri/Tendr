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

	/** Seconds the settings page keeps the API's status and settings (refreshed on save/switch). */
	const CACHE_TTL = 60;

	/** Seconds a failed read is kept, so a slow API is not asked on every page view. */
	const ERROR_TTL = 15;

	/** Seconds the settings page waits for the API when its cache is empty. */
	const API_WAIT = 3;

	/**
	 * Register the admin script.
	 */
	public static function register(): void {
		add_action( 'admin_enqueue_scripts', array( self::class, 'enqueue' ) );
		add_action( 'admin_post_tendr_set_mode', array( self::class, 'handle_mode_request' ) );
		add_action( 'admin_post_tendr_save_settings', array( self::class, 'handle_settings_request' ) );
		add_action( 'admin_notices', array( self::class, 'print_admin_notices' ) );
	}

	/**
	 * `admin_notices`: see admin_notices_html().
	 */
	public static function print_admin_notices(): void {
		echo self::admin_notices_html(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in admin_notices_html().
	}

	/**
	 * Site-wide notices for store managers (`manage_woocommerce`):
	 * - "tendr is in test mode" while connected in test mode (B2): only managers see the payment
	 *   method then, and payments are simulated;
	 * - the WordPress security keys cannot protect tendr's keys (C1): Connect is refused until
	 *   they are fixed.
	 */
	public static function admin_notices_html(): string {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return '';
		}
		$html  = '';
		$salts = Tendr_Credentials::site_salt_problem();
		if ( null !== $salts ) {
			$html .= '<div class="notice notice-error"><p>' . esc_html( Tendr_Credentials::salt_message( $salts ) ) . '</p></div>';
		}
		if ( Tendr_Connect::is_connected() && Tendr_Connect::site_address_changed() ) {
			$html .= '<div class="notice notice-error"><p>' . esc_html__( 'Your site address changed. Reconnect to tendr to update the checkout domain and payment notification address. Crypto checkout is paused until then.', 'tendr-pay-with-crypto' )
				. ' <a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Open tendr settings', 'tendr-pay-with-crypto' ) . '</a></p></div>';
		}
		if ( Tendr_Connect::is_connected() && 'test' === Tendr_Connect::mode() ) {
			$html .= '<div class="notice notice-warning tendr-test-mode"><p><strong>' . esc_html__( 'tendr is in test mode.', 'tendr-pay-with-crypto' ) . '</strong> '
				. esc_html__( 'Crypto payments are simulated and only store managers see the payment method.', 'tendr-pay-with-crypto' )
				. ' <a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Go live in the tendr settings', 'tendr-pay-with-crypto' ) . '</a></p></div>';
		}
		return $html;
	}

	// ------------------------------------------------------------------ mode and go live.

	/**
	 * Switch mode. Test needs no check. Live only when `GET /v1/connect/status`, asked with the
	 * LIVE key, says `ready`; otherwise the site stays in test mode and the blocking items are
	 * listed. Nudges (e.g. a single passkey) are always shown, ready or not.
	 *
	 * @param string $mode 'test' | 'live'.
	 * @return array{switched: bool, ready: bool, blocking: array, nudges: array, error: ?string}
	 */
	public static function set_mode( string $mode ): array {
		$result = array(
			'switched' => false,
			'ready'    => false,
			'blocking' => array(),
			'nudges'   => array(),
			'error'    => null,
		);
		if ( 'test' === $mode ) {
			update_option( Tendr_Connect::MODE, 'test' );
			$result['switched'] = true;
			self::remember_go_live( null );
			return $result;
		}
		if ( 'live' !== $mode ) {
			$result['error'] = __( 'Unknown mode.', 'tendr-pay-with-crypto' );
			return $result;
		}

		$status = self::connect_status( true );
		if ( null !== $status['error'] ) {
			$result['error'] = __( 'Could not check with tendr whether your store is ready to go live, so this site stays in test mode.', 'tendr-pay-with-crypto' ) . ' ' . $status['error'];
		} else {
			$result['ready']    = $status['ready'];
			$result['blocking'] = $status['blocking'];
			$result['nudges']   = $status['nudges'];
			if ( $result['ready'] && array() === $result['blocking'] ) {
				update_option( Tendr_Connect::MODE, 'live' );
				$result['switched'] = true;
			} else {
				$result['ready'] = false;
			}
		}
		self::remember_go_live( $result );
		return $result;
	}

	/**
	 * `admin-post.php?action=tendr_set_mode` (POST, nonce, capability).
	 */
	public static function handle_mode_request(): void {
		$nonce = isset( $_POST['tendr_mode_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_mode_nonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, 'tendr_mode' ) || ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr-pay-with-crypto' ), 403 );
		}
		$mode = isset( $_POST['tendr_mode'] ) ? sanitize_key( wp_unslash( $_POST['tendr_mode'] ) ) : '';
		self::set_mode( $mode );
		wp_safe_redirect( self::url() );
		exit;
	}

	/**
	 * Blocking items / nudges from the API: `{code, message, href}`, with only links to the tendr
	 * site kept (anything else links to the dashboard).
	 *
	 * @param mixed $raw API list.
	 * @return array<int, array{code: string, message: string, href: string}>
	 */
	private static function items( $raw ): array {
		$out  = array();
		$base = Tendr_Plugin::app_base();
		foreach ( is_array( $raw ) ? $raw : array() as $item ) {
			if ( ! is_array( $item ) || ! isset( $item['message'] ) || ! is_string( $item['message'] ) ) {
				continue;
			}
			$href  = isset( $item['href'] ) && is_string( $item['href'] ) ? $item['href'] : '';
			$out[] = array(
				'code'    => isset( $item['code'] ) && is_string( $item['code'] ) ? $item['code'] : '',
				'message' => $item['message'],
				'href'    => ( $href === $base || str_starts_with( $href, $base . '/' ) ) ? $href : $base . '/dashboard',
			);
		}
		return $out;
	}

	/**
	 * Keep the last go-live answer for the current user, shown once on the next page load.
	 *
	 * @param array|null $result From set_mode(), or null to forget it.
	 */
	private static function remember_go_live( ?array $result ): void {
		$user = get_current_user_id();
		if ( $user <= 0 ) {
			return;
		}
		if ( null === $result ) {
			delete_transient( 'tendr_golive_' . $user );
			return;
		}
		set_transient( 'tendr_golive_' . $user, $result, 5 * MINUTE_IN_SECONDS );
	}

	/**
	 * Print and forget the last go-live answer.
	 */
	private static function take_go_live(): string {
		$user = get_current_user_id();
		if ( $user <= 0 ) {
			return '';
		}
		$result = get_transient( 'tendr_golive_' . $user );
		if ( ! is_array( $result ) ) {
			return '';
		}
		delete_transient( 'tendr_golive_' . $user );

		$html = '';
		if ( ! empty( $result['switched'] ) ) {
			$html .= self::notice( 'success', __( 'This site is now in live mode: shoppers pay with real crypto.', 'tendr-pay-with-crypto' ) );
		} elseif ( ! empty( $result['error'] ) ) {
			$html .= self::notice( 'error', (string) $result['error'] );
		} else {
			$html .= '<div class="notice notice-error inline"><p>' . esc_html__( 'This site stays in test mode until your store is ready to go live:', 'tendr-pay-with-crypto' ) . '</p>'
				. self::item_list( (array) ( $result['blocking'] ?? array() ) ) . '</div>';
		}
		return $html;
	}

	/**
	 * The nudges (e.g. a single passkey), shown on every page view from the cached status.
	 */
	private static function nudges_html(): string {
		$status = self::connect_status();
		return array() === $status['nudges'] ? '' : '<div class="notice notice-warning inline">' . self::item_list( $status['nudges'] ) . '</div>';
	}

	/**
	 * `GET /v1/connect/status` with the LIVE key, cached for CACHE_TTL so the settings page never
	 * waits on it; refreshed by a mode switch.
	 *
	 * @param bool $refresh Ask the API now.
	 * @return array{ready: bool, blocking: array, nudges: array, error: ?string}
	 */
	public static function connect_status( bool $refresh = false ): array {
		$key    = self::cache_key( 'status' );
		$cached = $refresh ? false : get_transient( $key );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$status = Tendr_Api_Client::request( 'GET', '/v1/connect/status', array(), 'live', array(), self::API_WAIT );
		$result = is_wp_error( $status )
			? array(
				'ready'    => false,
				'blocking' => array(),
				'nudges'   => array(),
				'error'    => $status->get_error_message(),
			)
			: array(
				'ready'    => true === ( $status['ready'] ?? null ),
				'blocking' => self::items( $status['blocking'] ?? array() ),
				'nudges'   => self::items( $status['nudges'] ?? array() ),
				'error'    => null,
			);
		set_transient( $key, $result, null === $result['error'] ? self::CACHE_TTL : self::ERROR_TTL );
		return $result;
	}

	/**
	 * A per-connection cache key.
	 *
	 * @param string $what 'status' | 'settings'.
	 */
	private static function cache_key( string $what ): string {
		$connection = Tendr_Connect::connection();
		return 'tendr_' . $what . '_' . substr( md5( (string) ( $connection['id'] ?? '' ) ), 0, 12 );
	}

	/**
	 * A list of `{message, href}` items as links.
	 *
	 * @param array $items From items().
	 */
	private static function item_list( array $items ): string {
		$html = '<ul>';
		foreach ( $items as $item ) {
			$html .= '<li>' . esc_html( (string) ( $item['message'] ?? '' ) );
			if ( ! empty( $item['href'] ) ) {
				$html .= ' <a href="' . esc_url( (string) $item['href'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Open in tendr', 'tendr-pay-with-crypto' ) . '</a>';
			}
			$html .= '</li>';
		}
		return $html . '</ul>';
	}

	// ------------------------------------------------------------------ store settings.

	/**
	 * The store's settings as tendr has them (`GET /v1/settings/checkout`), or an error. Cached
	 * for CACHE_TTL (failures for ERROR_TTL) so the page never waits long; a save refreshes it.
	 *
	 * @param bool $refresh Ask the API now.
	 *
	 * @return array{default_fee_payer: string, default_gas_payer: string, notification_email: ?string, notification_email_pending: ?string}|WP_Error
	 */
	public static function store_settings( bool $refresh = false ) {
		$key    = self::cache_key( 'settings' );
		$cached = $refresh ? false : get_transient( $key );
		if ( is_array( $cached ) ) {
			return isset( $cached['error'] ) ? new WP_Error( 'tendr_settings_unavailable', (string) $cached['error'] ) : $cached;
		}
		$view = Tendr_Api_Client::request( 'GET', '/v1/settings/checkout', array(), Tendr_Connect::mode(), array(), self::API_WAIT );
		if ( is_wp_error( $view ) ) {
			set_transient( $key, array( 'error' => $view->get_error_message() ), self::ERROR_TTL );
			return $view;
		}
		$settings = self::settings_view( $view );
		set_transient( $key, $settings, self::CACHE_TTL );
		return $settings;
	}

	/**
	 * Save the store settings through the API (`PATCH /v1/settings/checkout`), sending only what
	 * changed. They apply store-wide, to every connected site. A new notification email takes
	 * effect only once its verify link is clicked.
	 *
	 * @param array $input default_fee_payer, default_gas_payer ('merchant'|'shopper'),
	 *                     notification_email ('' for the store owners).
	 * @return array|WP_Error The settings as tendr now has them.
	 */
	public static function save_settings( array $input ) {
		$patch = array();
		foreach ( array( 'default_fee_payer', 'default_gas_payer' ) as $key ) {
			if ( ! isset( $input[ $key ] ) ) {
				continue;
			}
			if ( ! in_array( $input[ $key ], array( 'merchant', 'shopper' ), true ) ) {
				return new WP_Error( 'tendr_invalid_setting', __( 'Choose who pays: the store or the customer.', 'tendr-pay-with-crypto' ) );
			}
			$patch[ $key ] = $input[ $key ];
		}
		if ( isset( $input['notification_email'] ) ) {
			$email = strtolower( trim( (string) $input['notification_email'] ) );
			if ( '' !== $email && ( ! is_email( $email ) || sanitize_email( $email ) !== $email ) ) {
				return new WP_Error( 'tendr_invalid_email', __( 'Enter a valid email address, or leave it empty to send notices to the store owners.', 'tendr-pay-with-crypto' ) );
			}
			$patch['notification_email'] = '' === $email ? null : $email;
		}

		$current = self::store_settings( true );
		if ( is_wp_error( $current ) ) {
			return $current;
		}
		foreach ( $patch as $key => $value ) {
			if ( $current[ $key ] === $value ) {
				unset( $patch[ $key ] );
			}
		}
		if ( array() === $patch ) {
			return $current;
		}
		$saved = Tendr_Api_Client::request( 'PATCH', '/v1/settings/checkout', $patch, Tendr_Connect::mode() );
		if ( is_wp_error( $saved ) ) {
			return $saved;
		}
		$settings = self::settings_view( $saved );
		set_transient( self::cache_key( 'settings' ), $settings, self::CACHE_TTL );
		return $settings;
	}

	/**
	 * `admin-post.php?action=tendr_save_settings` (POST, nonce, capability).
	 */
	public static function handle_settings_request(): void {
		$nonce = isset( $_POST['tendr_settings_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_settings_nonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, 'tendr_settings' ) || ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr-pay-with-crypto' ), 403 );
		}
		$input = array();
		$map   = array(
			'tendr_fee_payer'          => 'default_fee_payer',
			'tendr_gas_payer'          => 'default_gas_payer',
			'tendr_notification_email' => 'notification_email',
		);
		foreach ( $map as $field => $key ) {
			if ( isset( $_POST[ $field ] ) ) {
				$input[ $key ] = sanitize_text_field( wp_unslash( $_POST[ $field ] ) );
			}
		}
		$saved = self::save_settings( $input );
		if ( is_wp_error( $saved ) ) {
			self::flash( 'error', __( 'Settings not saved:', 'tendr-pay-with-crypto' ) . ' ' . $saved->get_error_message() );
		} else {
			self::flash( 'success', __( 'Settings saved. They apply to all sites connected to this store.', 'tendr-pay-with-crypto' ) );
		}
		wp_safe_redirect( self::url() );
		exit;
	}

	/**
	 * The settings fields from an API view.
	 *
	 * @param array $view `GET/PATCH /v1/settings/checkout` response.
	 */
	private static function settings_view( array $view ): array {
		$who = static fn( $v ) => 'shopper' === $v ? 'shopper' : 'merchant';
		$em  = static fn( $v ) => is_string( $v ) && '' !== $v ? $v : null;
		return array(
			'default_fee_payer'          => $who( $view['default_fee_payer'] ?? null ),
			'default_gas_payer'          => $who( $view['default_gas_payer'] ?? null ),
			'notification_email'         => $em( $view['notification_email'] ?? null ),
			'notification_email_pending' => $em( $view['notification_email_pending'] ?? null ),
		);
	}

	/**
	 * The settings fields, showing what tendr has (never the last local input).
	 *
	 * @param string $post admin-post.php URL.
	 */
	private static function settings_fields( string $post ): string {
		$settings = self::store_settings();
		if ( is_wp_error( $settings ) ) {
			return self::notice( 'warning', __( 'Could not load the store settings from tendr:', 'tendr-pay-with-crypto' ) . ' ' . $settings->get_error_message() );
		}
		$choices = array(
			'merchant' => __( 'The store', 'tendr-pay-with-crypto' ),
			'shopper'  => __( 'The customer', 'tendr-pay-with-crypto' ),
		);
		$select  = static function ( string $name, string $current ) use ( $choices ): string {
			$html = '<select name="' . esc_attr( $name ) . '" id="' . esc_attr( $name ) . '">';
			foreach ( $choices as $value => $label ) {
				$html .= '<option value="' . esc_attr( $value ) . '"' . selected( $current, $value, false ) . '>' . esc_html( $label ) . '</option>';
			}
			return $html . '</select>';
		};

		$html  = '<p class="tendr-admin-description">' . esc_html__( 'Applies to all sites connected to this store.', 'tendr-pay-with-crypto' ) . '</p><div class="tendr-admin-fields">';
		$html .= '<div class="tendr-admin-field"><label for="tendr_fee_payer">' . esc_html__( 'Who pays the tendr fee', 'tendr-pay-with-crypto' ) . '</label>'
			. $select( 'tendr_fee_payer', $settings['default_fee_payer'] ) . '</div>';
		$html .= '<div class="tendr-admin-field"><label for="tendr_gas_payer">' . esc_html__( 'Who pays network costs', 'tendr-pay-with-crypto' ) . '</label>'
			. $select( 'tendr_gas_payer', $settings['default_gas_payer'] ) . '</div>';
		$html .= '<div class="tendr-admin-field tendr-admin-field-wide"><label for="tendr_notification_email">' . esc_html__( 'Email for payment and refund notices', 'tendr-pay-with-crypto' ) . '</label>'
			. '<input type="email" name="tendr_notification_email" id="tendr_notification_email" value="' . esc_attr( (string) $settings['notification_email'] ) . '" placeholder="' . esc_attr__( 'The store owners', 'tendr-pay-with-crypto' ) . '" aria-describedby="tendr-email-help">'
			. '<p id="tendr-email-help" class="description">' . esc_html__( 'Leave blank to notify the store owners. A new address must be verified before it receives notices.', 'tendr-pay-with-crypto' ) . '</p>';
		if ( null !== $settings['notification_email_pending'] ) {
			$html .= self::notice(
				'info',
				sprintf(
					/* translators: %s: email address waiting for confirmation. */
					__( 'Check your inbox to confirm %s. Notices go there once the link in that email is clicked.', 'tendr-pay-with-crypto' ),
					$settings['notification_email_pending']
				)
			);
		}
		$html .= '</div></div><div class="tendr-admin-card-footer">' . wp_nonce_field( 'tendr_settings', 'tendr_settings_nonce', false, false )
			. '<button type="submit" class="button button-primary" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_save_settings', $post ) ) . '">' . esc_html__( 'Save settings', 'tendr-pay-with-crypto' ) . '</button></div>';
		return $html;
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
		wp_enqueue_style( 'tendr-admin', plugins_url( 'assets/css/admin.css', TENDR_PLUGIN_FILE ), array(), TENDR_VERSION );
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
				'confirm' => __( 'Disconnect this site from tendr? Its keys are revoked and it stops taking crypto payments.', 'tendr-pay-with-crypto' ),
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
		$html  = '<div class="tendr-admin"><header class="tendr-admin-header"><div class="tendr-admin-brand">'
			. '<img src="' . esc_url( plugins_url( 'assets/images/tendr-mark-white.png', TENDR_PLUGIN_FILE ) ) . '" width="42" height="26" alt=""><span>tendr</span><span class="tendr-admin-platform">WooCommerce</span></div>'
			. '<h2>' . esc_html__( 'Crypto payments, connected.', 'tendr-pay-with-crypto' ) . '</h2><p>' . esc_html__( 'Your store. Your funds. One place to manage your checkout.', 'tendr-pay-with-crypto' ) . '</p></header>';
		$html .= self::take_flash();

		$connection = Tendr_Connect::connection();
		$status     = Tendr_Credentials::status();
		$blocker    = Tendr_Connect::blocker();

		if ( null !== $connection && 'ok' === $status ) {
			if ( Tendr_Connect::site_address_changed() ) {
				$html .= self::notice( 'error', __( 'Your site address changed. Reconnect to the same tendr store to update the checkout domain and payment notifications. Crypto checkout is paused until you reconnect. Reconnecting starts in Test mode; switch back to Live after checking the connection.', 'tendr-pay-with-crypto' ) );
			}
			if ( null !== $blocker ) {
				$html .= self::notice( 'error', __( 'Payment updates cannot reach this site:', 'tendr-pay-with-crypto' ) . ' ' . $blocker->get_error_message(), self::fix_link( $blocker ) );
			}
			return $html . self::connected( $connection ) . '</div>';
		}
		$html .= '<section class="tendr-admin-card tendr-admin-welcome"><p class="tendr-admin-eyebrow">' . esc_html__( 'Get started', 'tendr-pay-with-crypto' ) . '</p><h3>' . esc_html__( 'Bring crypto to your checkout.', 'tendr-pay-with-crypto' ) . '</h3>';

		if ( 'unreadable' === $status || null !== $connection ) {
			$html .= self::notice(
				'warning',
				__( 'Reconnect to tendr. This site\'s stored tendr keys can no longer be read (the WordPress security keys in wp-config.php changed), so it cannot take crypto payments until you reconnect.', 'tendr-pay-with-crypto' )
			);
			$label = __( 'Reconnect to tendr', 'tendr-pay-with-crypto' );
		} else {
			$html .= '<p>' . esc_html__( 'Connect this site to your tendr store to take crypto payments. You approve it on usetendr.tech, and there are no keys to copy.', 'tendr-pay-with-crypto' ) . '</p>';
			$label = __( 'Connect to tendr', 'tendr-pay-with-crypto' );
		}

		if ( null !== $blocker ) {
			$html .= self::notice( 'error', $blocker->get_error_message(), self::fix_link( $blocker ) );
			return $html . '<p><button type="button" class="button button-primary" disabled>' . esc_html( $label ) . '</button></p></section></div>';
		}

		$start = wp_nonce_url( admin_url( 'admin-post.php?action=tendr_connect_start' ), 'tendr_connect_start' );
		return $html
			. '<p><button type="button" class="button button-primary" data-tendr-connect="' . esc_url( $start ) . '">' . esc_html( $label ) . '</button>'
			. ' <span class="tendr-connect-status" role="status" aria-live="polite"></span></p>'
			. '<ol class="tendr-admin-steps"><li><strong>' . esc_html__( 'Connect your store', 'tendr-pay-with-crypto' ) . '</strong><span>' . esc_html__( 'Sign in to Tendr and approve this site.', 'tendr-pay-with-crypto' ) . '</span></li>'
			. '<li><strong>' . esc_html__( 'Try a test payment', 'tendr-pay-with-crypto' ) . '</strong><span>' . esc_html__( 'Walk through checkout with a simulated payment.', 'tendr-pay-with-crypto' ) . '</span></li>'
			. '<li><strong>' . esc_html__( 'Go live when ready', 'tendr-pay-with-crypto' ) . '</strong><span>' . esc_html__( 'Check your setup and start accepting crypto.', 'tendr-pay-with-crypto' ) . '</span></li></ol></section></div>';
	}

	/**
	 * The connected state: store, account, mode, links, Disconnect.
	 *
	 * @param array $connection Public connection details.
	 */
	private static function connected( array $connection ): string {
		$live      = 'live' === Tendr_Connect::mode();
		$dashboard = Tendr_Plugin::dashboard_url( '/dashboard', $live ? 'live' : 'test' );
		$review    = Tendr_Plugin::dashboard_url( '/dashboard/review', $live ? 'live' : 'test' );
		$mode      = $live ? __( 'Live mode', 'tendr-pay-with-crypto' ) : __( 'Test mode', 'tendr-pay-with-crypto' );
		$post      = admin_url( 'admin-post.php' );

		// Every control posts WooCommerce's settings form to its own admin-post action
		// (formaction), each with its own nonce: this page is inside WooCommerce's <form>.
		$html  = self::take_go_live() . self::nudges_html();
		$html .= '<div class="tendr-admin-grid"><div class="tendr-admin-main"><section class="tendr-admin-card"><div class="tendr-admin-card-heading"><h3>' . esc_html__( 'Store connection', 'tendr-pay-with-crypto' ) . '</h3><span class="tendr-admin-badge">' . esc_html__( 'Connected', 'tendr-pay-with-crypto' ) . '</span></div>';
		$html .= '<p class="tendr-admin-description">' . esc_html__( 'Connected to', 'tendr-pay-with-crypto' ) . '</p><p class="tendr-admin-store-name">' . esc_html( (string) $connection['store_name'] ) . '</p>';
		$html .= '<dl class="tendr-admin-accounts">';
		if ( '' !== (string) ( $connection['test_account'] ?? '' ) ) {
			$html .= '<div><dt>' . esc_html__( 'Test account', 'tendr-pay-with-crypto' ) . '</dt><dd><code>' . esc_html( (string) $connection['test_account'] ) . '</code></dd></div>';
		}
		if ( '' !== (string) ( $connection['live_account'] ?? '' ) ) {
			$html .= '<div><dt>' . esc_html__( 'Live account', 'tendr-pay-with-crypto' ) . '</dt><dd><code>' . esc_html( (string) $connection['live_account'] ) . '</code></dd></div>';
		}
		$html .= '</dl><div class="tendr-admin-actions"><a class="button button-primary" href="' . esc_url( $dashboard ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Open tendr dashboard', 'tendr-pay-with-crypto' ) . '</a>'
			. '<a class="button" href="' . esc_url( $review ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Review queue', 'tendr-pay-with-crypto' ) . '</a>';
		if ( null === Tendr_Connect::blocker() ) {
			$start = wp_nonce_url( admin_url( 'admin-post.php?action=tendr_connect_start' ), 'tendr_connect_start' );
			$html .= '<button type="button" class="button" data-tendr-connect="' . esc_url( $start ) . '">' . esc_html__( 'Reconnect to tendr', 'tendr-pay-with-crypto' ) . '</button><span class="tendr-connect-status" role="status" aria-live="polite"></span>';
		}
		$html .= '</div></section>';
		$html .= '<section class="tendr-admin-card"><h3>' . esc_html__( 'Payment preferences', 'tendr-pay-with-crypto' ) . '</h3>' . self::settings_fields( $post ) . '</section></div>';
		$html .= '<aside class="tendr-admin-side"><section class="tendr-admin-card"><div class="tendr-admin-card-heading"><h3>' . esc_html__( 'Payment mode', 'tendr-pay-with-crypto' ) . '</h3><span class="tendr-admin-badge ' . ( $live ? 'tendr-admin-badge-dark' : '' ) . '">' . esc_html( $mode ) . '</span></div>'
			. '<p class="tendr-admin-description">' . ( $live
				? esc_html__( 'Shoppers pay with real crypto.', 'tendr-pay-with-crypto' )
				: esc_html__( 'Payments are simulated, and only store managers see the payment method. Going live checks with tendr that your store is ready.', 'tendr-pay-with-crypto' ) ) . '</p>'
			. wp_nonce_field( 'tendr_mode', 'tendr_mode_nonce', false, false )
			. '<button type="submit" class="button" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_set_mode', $post ) ) . '" name="tendr_mode" value="' . ( $live ? 'test' : 'live' ) . '">'
			. ( $live ? esc_html__( 'Switch to test mode', 'tendr-pay-with-crypto' ) : esc_html__( 'Switch to live mode', 'tendr-pay-with-crypto' ) ) . '</button>';
		if ( ! $live ) {
			$html .= '<p>' . wp_nonce_field( Tendr_Test_Purchase::NONCE, 'tendr_test_purchase_nonce', false, false )
				. '<button type="submit" class="button" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_test_purchase', $post ) ) . '">' . esc_html__( 'Make a test purchase', 'tendr-pay-with-crypto' ) . '</button></p>'
				. '<p class="description">' . esc_html__( 'Creates a test order of 1.00 in your store currency, with no product, and opens its payment page.', 'tendr-pay-with-crypto' ) . '</p>';
		}
		$html .= '</section><section class="tendr-admin-card"><h3>' . esc_html__( 'Checkout appearance', 'tendr-pay-with-crypto' ) . '</h3><p class="tendr-admin-description">' . esc_html__( 'Bring your store identity to the payment page. Sync your name, logo and theme colours with Tendr.', 'tendr-pay-with-crypto' ) . '</p>' . wp_nonce_field( Tendr_Brand::NONCE, 'tendr_brand_nonce', false, false )
			. '<button type="submit" class="button" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', Tendr_Brand::ACTION, $post ) ) . '">' . esc_html__( 'Refresh brand from my store', 'tendr-pay-with-crypto' ) . '</button>'
			. '</section></aside></div>';
		$html .= '<footer class="tendr-admin-footer"><span>' . esc_html__( 'Connected securely through Tendr', 'tendr-pay-with-crypto' ) . '</span>' . wp_nonce_field( 'tendr_disconnect', 'tendr_disconnect_nonce', false, false )
			. '<button type="submit" class="button button-link-delete" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_disconnect', $post ) ) . '" data-tendr-disconnect="' . esc_attr( self::disconnect_confirmation() ) . '">' . esc_html__( 'Disconnect', 'tendr-pay-with-crypto' ) . '</button>'
			. '</footer>';
		return $html;
	}

	/**
	 * The Disconnect confirmation, naming the orders still waiting for a crypto payment (A4).
	 */
	private static function disconnect_confirmation(): string {
		$text  = __( 'Disconnect this site from tendr? Its keys are revoked and it stops taking crypto payments.', 'tendr-pay-with-crypto' );
		$count = Tendr_Connect::open_order_count();
		if ( $count > 0 ) {
			$text .= ' ' . sprintf(
				/* translators: %d: number of orders. */
				_n(
					'%d order is waiting for a crypto payment. tendr closes its checkout, and a payment already on its way will not be reported on the order here: check it on your tendr dashboard.',
					'%d orders are waiting for a crypto payment. tendr closes their checkouts, and a payment already on its way will not be reported on the order here: check them on your tendr dashboard.',
					$count,
					'tendr-pay-with-crypto'
				),
				$count
			);
		}
		return $text;
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
				return '<a href="' . esc_url( admin_url( 'options-permalink.php' ) ) . '">' . esc_html__( 'Open permalink settings', 'tendr-pay-with-crypto' ) . '</a>';
			case 'tendr_admin_origin':
				return '<a href="' . esc_url( admin_url( 'options-general.php' ) ) . '">' . esc_html__( 'Open general settings', 'tendr-pay-with-crypto' ) . '</a>';
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
