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
		add_action( 'admin_post_tendr_set_mode', array( self::class, 'handle_mode_request' ) );
		add_action( 'admin_post_tendr_save_settings', array( self::class, 'handle_settings_request' ) );
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

		$status = Tendr_Api_Client::request( 'GET', '/v1/connect/status', array(), 'live' );
		if ( is_wp_error( $status ) ) {
			$result['error'] = __( 'Could not check with tendr whether your store is ready to go live, so this site stays in test mode.', 'tendr' ) . ' ' . $status->get_error_message();
		} else {
			$result['ready']    = true === ( $status['ready'] ?? null );
			$result['blocking'] = self::items( $status['blocking'] ?? array() );
			$result['nudges']   = self::items( $status['nudges'] ?? array() );
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
		$base = Tendr_Plugin::checkout_base();
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
		if ( ! empty( $result['nudges'] ) ) {
			$html .= '<div class="notice notice-warning inline">' . self::item_list( (array) $result['nudges'] ) . '</div>';
		}
		return $html;
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
	 * The store's settings as tendr has them (`GET /v1/settings/checkout`), or an error.
	 *
	 * @return array{default_fee_payer: string, default_gas_payer: string, notification_email: ?string, notification_email_pending: ?string}|WP_Error
	 */
	public static function store_settings() {
		$view = Tendr_Api_Client::request( 'GET', '/v1/settings/checkout', array(), Tendr_Connect::mode(), array(), 5 );
		return is_wp_error( $view ) ? $view : self::settings_view( $view );
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

		$current = self::store_settings();
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
		return is_wp_error( $saved ) ? $saved : self::settings_view( $saved );
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
		$live       = 'live' === Tendr_Connect::mode();
		$mode       = $live ? __( 'Live mode', 'tendr' ) : __( 'Test mode', 'tendr' );
		$post       = admin_url( 'admin-post.php' );

		// Every control posts WooCommerce's settings form to its own admin-post action
		// (formaction), each with its own nonce: this page is inside WooCommerce's <form>.
		$html  = self::take_go_live();
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
