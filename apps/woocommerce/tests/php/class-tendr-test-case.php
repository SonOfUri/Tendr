<?php
/**
 * Shared helpers: HTTP mocked through `pre_http_request`, fake Connect credentials, users.
 *
 * @package Tendr
 */

/**
 * Base test case for the plugin.
 */
abstract class Tendr_Test_Case extends WP_UnitTestCase {

	/**
	 * Requests the plugin made: each `['url' => string, 'args' => array]`.
	 *
	 * @var array<int, array{url: string, args: array}>
	 */
	protected array $requests = array();

	/**
	 * Set up: pretty permalinks (the Connect requirement) and an empty request log.
	 */
	public function set_up(): void {
		parent::set_up();
		$this->requests = array();
		$this->set_permalink_structure( '/%postname%/' );
		$this->unmocked = array();
		// No test ever reaches the network. A request no mock answered is blocked and fails the test
		// in tear_down(), so it can never satisfy an error-path assertion by accident.
		add_filter(
			'pre_http_request',
			function ( $pre, $args, $url ) {
				if ( false !== $pre ) {
					return $pre;
				}
				$this->unmocked[] = $url;
				return new WP_Error( 'http_request_failed', 'Unmocked HTTP request in a test.' );
			},
			PHP_INT_MAX,
			3
		);
	}

	/**
	 * URLs requested without a mock.
	 *
	 * @var string[]
	 */
	protected array $unmocked = array();

	/**
	 * Tear down: no user, no HTTP mock; fail on any unmocked request.
	 */
	public function tear_down(): void {
		remove_all_filters( 'pre_http_request' );
		wp_set_current_user( 0 );
		$unmocked       = $this->unmocked;
		$this->unmocked = array();
		parent::tear_down();
		if ( array() !== $unmocked ) {
			$this->fail( 'Unmocked HTTP request(s): ' . implode( ', ', $unmocked ) );
		}
	}

	/**
	 * Answer every outgoing request with `$responder( $url, $args )`, recording each request.
	 * The responder returns a `wp_remote_request()`-shaped array or a WP_Error.
	 *
	 * @param callable $responder Builds the response.
	 */
	protected function mock_http( callable $responder ): void {
		add_filter(
			'pre_http_request',
			function ( $pre, $args, $url ) use ( $responder ) {
				$this->requests[] = array(
					'url'  => $url,
					'args' => $args,
				);
				return $responder( $url, $args );
			},
			10,
			3
		);
	}

	/**
	 * A `wp_remote_request()`-shaped response.
	 *
	 * @param int        $status HTTP status.
	 * @param array|null $json   JSON body, or null for none.
	 */
	protected static function response( int $status, ?array $json = null ): array {
		return array(
			'headers'  => array( 'content-type' => 'application/json' ),
			'body'     => null === $json ? '' : wp_json_encode( $json ),
			'response' => array(
				'code'    => $status,
				'message' => get_status_header_desc( $status ),
			),
			'cookies'  => array(),
			'filename' => null,
		);
	}

	/**
	 * A `POST /v1/connect/token` response (ConnectTokenResponseSchema).
	 *
	 * @param string $tag Makes every value unique, to tell connections apart.
	 */
	protected static function issued( string $tag = 'a' ): array {
		return array(
			'connection_id' => "con_{$tag}",
			'store'         => array(
				'id'           => "mer_{$tag}",
				'name'         => "Corner Shop {$tag}",
				'test_account' => "corner-{$tag}.tendr.testnet",
				'live_account' => null,
			),
			'test'          => array(
				'secret_key'      => "tdr_test_SECRETtest{$tag}0123456789",
				'publishable_key' => "tdr_pk_test_PUBtest{$tag}0123456789",
				'webhook_secret'  => "whsec_WHtest{$tag}0123456789",
			),
			'live'          => array(
				'secret_key'      => "tdr_live_SECRETlive{$tag}0123456789",
				'publishable_key' => "tdr_pk_live_PUBlive{$tag}0123456789",
				'webhook_secret'  => "whsec_WHlive{$tag}0123456789",
			),
		);
	}

	/**
	 * Every secret value in an issued response.
	 *
	 * @param array $issued From issued().
	 * @return string[]
	 */
	protected static function secrets_of( array $issued ): array {
		return array(
			$issued['test']['secret_key'],
			$issued['test']['webhook_secret'],
			$issued['live']['secret_key'],
			$issued['live']['webhook_secret'],
		);
	}

	/**
	 * Log in as a new administrator (has manage_woocommerce once WooCommerce is installed).
	 */
	protected function login_admin(): int {
		$id = self::factory()->user->create( array( 'role' => 'administrator' ) );
		wp_set_current_user( $id );
		return $id;
	}

	/**
	 * Store a connection as a successful Connect would, without HTTP.
	 *
	 * @param string $tag See issued().
	 */
	protected static function connect_locally( string $tag = 'a' ): array {
		$issued = self::issued( $tag );
		Tendr_Connect::save_connection( $issued, home_url() );
		return $issued;
	}

	/**
	 * Parse a URL's query string.
	 *
	 * @param string $url The URL.
	 */
	protected static function query_of( string $url ): array {
		$out = array();
		wp_parse_str( (string) wp_parse_url( $url, PHP_URL_QUERY ), $out );
		return $out;
	}
}
