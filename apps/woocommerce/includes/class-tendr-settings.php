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
		if ( Tendr_Connect::is_connected() && 'test' === Tendr_Connect::mode() ) {
			$html .= '<div class="notice notice-warning tendr-test-mode"><p><strong>' . esc_html__( 'tendr is in test mode.', 'tendr' ) . '</strong> '
				. esc_html__( 'Crypto payments are simulated and only store managers see the payment method.', 'tendr' )
				. ' <a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Go live in the tendr settings', 'tendr' ) . '</a></p></div>';
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
			$result['error'] = __( 'Unknown mode.', 'tendr' );
			return $result;
		}

		$status = self::connect_status( true );
		if ( null !== $status['error'] ) {
			$result['error'] = __( 'Could not check with tendr whether your store is ready to go live, so this site stays in test mode.', 'tendr' ) . ' ' . $status['error'];
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
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr' ), 403 );
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
			$html .= self::notice( 'success', __( 'This site is now in live mode: shoppers pay with real crypto.', 'tendr' ) );
		} elseif ( ! empty( $result['error'] ) ) {
			$html .= self::notice( 'error', (string) $result['error'] );
		} else {
			$html .= '<div class="notice notice-error inline"><p>' . esc_html__( 'This site stays in test mode until your store is ready to go live:', 'tendr' ) . '</p>'
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
				$html .= ' <a href="' . esc_url( (string) $item['href'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Open in tendr', 'tendr' ) . '</a>';
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
				return new WP_Error( 'tendr_invalid_setting', __( 'Choose who pays: the store or the customer.', 'tendr' ) );
			}
			$patch[ $key ] = $input[ $key ];
		}
		if ( isset( $input['notification_email'] ) ) {
			$email = strtolower( trim( (string) $input['notification_email'] ) );
			if ( '' !== $email && ( ! is_email( $email ) || sanitize_email( $email ) !== $email ) ) {
				return new WP_Error( 'tendr_invalid_email', __( 'Enter a valid email address, or leave it empty to send notices to the store owners.', 'tendr' ) );
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
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr' ), 403 );
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
			self::flash( 'error', __( 'Settings not saved:', 'tendr' ) . ' ' . $saved->get_error_message() );
		} else {
			self::flash( 'success', __( 'Settings saved. They apply to all sites connected to this store.', 'tendr' ) );
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
	 * The settings rows, showing what tendr has (never the last local input).
	 *
	 * @param string $post admin-post.php URL.
	 */
	private static function settings_rows( string $post ): string {
		$settings = self::store_settings();
		if ( is_wp_error( $settings ) ) {
			return '<tr><th scope="row">' . esc_html__( 'Store settings', 'tendr' ) . '</th><td>'
				. self::notice( 'warning', __( 'Could not load the store settings from tendr:', 'tendr' ) . ' ' . $settings->get_error_message() ) . '</td></tr>';
		}
		$choices = array(
			'merchant' => __( 'The store', 'tendr' ),
			'shopper'  => __( 'The customer', 'tendr' ),
		);
		$select  = static function ( string $name, string $current ) use ( $choices ): string {
			$html = '<select name="' . esc_attr( $name ) . '" id="' . esc_attr( $name ) . '">';
			foreach ( $choices as $value => $label ) {
				$html .= '<option value="' . esc_attr( $value ) . '"' . selected( $current, $value, false ) . '>' . esc_html( $label ) . '</option>';
			}
			return $html . '</select>';
		};
		$shared  = '<p class="description">' . esc_html__( 'Applies to all sites connected to this store.', 'tendr' ) . '</p>';

		$html  = '<tr><th scope="row"><label for="tendr_fee_payer">' . esc_html__( 'Who pays the tendr fee', 'tendr' ) . '</label></th><td>'
			. $select( 'tendr_fee_payer', $settings['default_fee_payer'] ) . $shared . '</td></tr>';
		$html .= '<tr><th scope="row"><label for="tendr_gas_payer">' . esc_html__( 'Who pays network costs', 'tendr' ) . '</label></th><td>'
			. $select( 'tendr_gas_payer', $settings['default_gas_payer'] ) . $shared . '</td></tr>';
		$html .= '<tr><th scope="row"><label for="tendr_notification_email">' . esc_html__( 'Email for payment and refund notices', 'tendr' ) . '</label></th><td>'
			. '<input type="email" class="regular-text" name="tendr_notification_email" id="tendr_notification_email" value="' . esc_attr( (string) $settings['notification_email'] ) . '" placeholder="' . esc_attr__( 'The store owners', 'tendr' ) . '">';
		if ( null !== $settings['notification_email_pending'] ) {
			$html .= self::notice(
				'info',
				sprintf(
					/* translators: %s: email address waiting for confirmation. */
					__( 'Check your inbox to confirm %s. Notices go there once the link in that email is clicked.', 'tendr' ),
					$settings['notification_email_pending']
				)
			);
		}
		$html .= $shared . '</td></tr>';
		$html .= '<tr><th scope="row"></th><td>' . wp_nonce_field( 'tendr_settings', 'tendr_settings_nonce', false, false )
			. '<button type="submit" class="button button-primary" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_save_settings', $post ) ) . '">' . esc_html__( 'Save settings', 'tendr' ) . '</button></td></tr>';
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
				'confirm' => __( 'Disconnect this site from tendr? Its keys are revoked and it stops taking crypto payments.', 'tendr' ),
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
		$live      = 'live' === Tendr_Connect::mode();
		$dashboard = Tendr_Plugin::dashboard_url( '/dashboard', $live ? 'live' : 'test' );
		$review    = Tendr_Plugin::dashboard_url( '/dashboard/review', $live ? 'live' : 'test' );
		$mode      = $live ? __( 'Live mode', 'tendr' ) : __( 'Test mode', 'tendr' );
		$post      = admin_url( 'admin-post.php' );

		// Every control posts WooCommerce's settings form to its own admin-post action
		// (formaction), each with its own nonce: this page is inside WooCommerce's <form>.
		$html  = self::take_go_live() . self::nudges_html();
		$html .= '<p>' . esc_html__( 'Connected to', 'tendr' ) . ' <strong>' . esc_html( (string) $connection['store_name'] ) . '</strong></p>';
		$html .= '<table class="form-table" role="presentation"><tbody>';
		if ( '' !== (string) ( $connection['test_account'] ?? '' ) ) {
			$html .= '<tr><th scope="row">' . esc_html__( 'Test account', 'tendr' ) . '</th><td><code>' . esc_html( (string) $connection['test_account'] ) . '</code></td></tr>';
		}
		if ( '' !== (string) ( $connection['live_account'] ?? '' ) ) {
			$html .= '<tr><th scope="row">' . esc_html__( 'Live account', 'tendr' ) . '</th><td><code>' . esc_html( (string) $connection['live_account'] ) . '</code></td></tr>';
		}
		$html .= '<tr><th scope="row">' . esc_html__( 'Mode', 'tendr' ) . '</th><td><strong>' . esc_html( $mode ) . '</strong> '
			. wp_nonce_field( 'tendr_mode', 'tendr_mode_nonce', false, false )
			. '<button type="submit" class="button" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_set_mode', $post ) ) . '" name="tendr_mode" value="' . ( $live ? 'test' : 'live' ) . '">'
			. ( $live ? esc_html__( 'Switch to test mode', 'tendr' ) : esc_html__( 'Switch to live mode', 'tendr' ) ) . '</button>'
			. '<p class="description">' . ( $live
				? esc_html__( 'Shoppers pay with real crypto.', 'tendr' )
				: esc_html__( 'Payments are simulated, and only store managers see the payment method. Going live checks with tendr that your store is ready.', 'tendr' ) ) . '</p>';
		if ( ! $live ) {
			$html .= '<p>' . wp_nonce_field( Tendr_Test_Purchase::NONCE, 'tendr_test_purchase_nonce', false, false )
				. '<button type="submit" class="button" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_test_purchase', $post ) ) . '">' . esc_html__( 'Make a test purchase', 'tendr' ) . '</button></p>'
				. '<p class="description">' . esc_html__( 'Creates a test order of 1.00 in your store currency, with no product, and opens its payment page.', 'tendr' ) . '</p>';
		}
		$html .= '</td></tr>';
		$html .= self::settings_rows( $post );
		$html .= '<tr><th scope="row">' . esc_html__( 'Checkout look', 'tendr' ) . '</th><td>' . wp_nonce_field( Tendr_Brand::NONCE, 'tendr_brand_nonce', false, false )
			. '<button type="submit" class="button" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', Tendr_Brand::ACTION, $post ) ) . '">' . esc_html__( 'Refresh brand from my store', 'tendr' ) . '</button>'
			. '<p class="description">' . esc_html__( 'Sends your store name, logo and theme colours to tendr, to start a checkout theme from.', 'tendr' ) . '</p></td></tr>';
		$html .= '</tbody></table>';

		$html .= '<p>'
			. '<a class="button" href="' . esc_url( $dashboard ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Open tendr dashboard', 'tendr' ) . '</a> '
			. '<a class="button" href="' . esc_url( $review ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Review queue', 'tendr' ) . '</a> '
			. wp_nonce_field( 'tendr_disconnect', 'tendr_disconnect_nonce', false, false )
			. '<button type="submit" class="button button-link-delete" formmethod="post" formaction="' . esc_url( add_query_arg( 'action', 'tendr_disconnect', $post ) ) . '" data-tendr-disconnect="' . esc_attr( self::disconnect_confirmation() ) . '">' . esc_html__( 'Disconnect', 'tendr' ) . '</button>'
			. '</p>';
		return $html;
	}

	/**
	 * The Disconnect confirmation, naming the orders still waiting for a crypto payment (A4).
	 */
	private static function disconnect_confirmation(): string {
		$text  = __( 'Disconnect this site from tendr? Its keys are revoked and it stops taking crypto payments.', 'tendr' );
		$count = Tendr_Connect::open_order_count();
		if ( $count > 0 ) {
			$text .= ' ' . sprintf(
				/* translators: %d: number of orders. */
				_n(
					'%d order is waiting for a crypto payment. tendr closes its checkout, and a payment already on its way will not be reported on the order here: check it on your tendr dashboard.',
					'%d orders are waiting for a crypto payment. tendr closes their checkouts, and a payment already on its way will not be reported on the order here: check them on your tendr dashboard.',
					$count,
					'tendr'
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
