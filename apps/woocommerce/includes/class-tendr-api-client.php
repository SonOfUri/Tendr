<?php
/**
 * The tendr API client: JSON over `wp_remote_request`, Bearer auth with the connection key of a
 * mode, errors as WP_Error. Nothing it logs carries a secret.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * The tendr API client.
 */
final class Tendr_Api_Client {

	const TIMEOUT = 15;

	/** Anything shaped like a tendr key or webhook secret. */
	const SECRET_PATTERN = '/(?:tdr_[A-Za-z0-9]+_|whsec_)[A-Za-z0-9_\-]+/';

	/**
	 * Call the API with the connection's secret key for `$mode`.
	 *
	 * @param string $method  HTTP method.
	 * @param string $path    Path below the API base, e.g. `/v1/connect/status`.
	 * @param array  $body    JSON body (query arguments for GET).
	 * @param string $mode    'test' or 'live': which connection key to use.
	 * @param array  $headers Extra headers, e.g. `Idempotency-Key`.
	 * @param int    $timeout Seconds (shorter inside a webhook, whose sender waits 10 s).
	 * @return array|WP_Error The decoded JSON (an empty array for no content), or an error whose
	 *                        message is safe to show to the store admin.
	 */
	public static function request( string $method, string $path, array $body = array(), string $mode = 'test', array $headers = array(), int $timeout = self::TIMEOUT ) {
		$credentials = Tendr_Credentials::get( $mode );
		if ( null === $credentials ) {
			return new WP_Error( 'tendr_not_connected', __( 'This site is not connected to tendr. Connect it from the tendr payment settings.', 'tendr' ) );
		}
		$headers['Authorization'] = 'Bearer ' . $credentials['secret_key'];
		return self::send( $method, $path, $body, $headers, $timeout );
	}

	/**
	 * Call an unauthenticated endpoint (`POST /v1/connect/token`).
	 *
	 * @param string $method  HTTP method.
	 * @param string $path    Path below the API base.
	 * @param array  $body    JSON body.
	 * @param array  $headers Extra headers.
	 * @return array|WP_Error
	 */
	public static function request_public( string $method, string $path, array $body = array(), array $headers = array() ) {
		unset( $headers['Authorization'] );
		return self::send( $method, $path, $body, $headers );
	}

	/**
	 * Send the request and map the response.
	 *
	 * @param string $method  HTTP method.
	 * @param string $path    Path.
	 * @param array  $body    Body.
	 * @param array  $headers Headers (may carry Authorization).
	 * @param int    $timeout Seconds.
	 * @return array|WP_Error
	 */
	private static function send( string $method, string $path, array $body, array $headers, int $timeout = self::TIMEOUT ) {
		$method = strtoupper( $method );
		$url    = Tendr_Plugin::api_base() . '/' . ltrim( $path, '/' );

		$headers = array_merge(
			array(
				'Accept'     => 'application/json',
				'User-Agent' => Tendr_Plugin::user_agent(),
			),
			$headers
		);

		$args = array(
			'method'      => $method,
			'timeout'     => max( 1, $timeout ),
			'sslverify'   => true,
			// Never replay the Authorization header to another location.
			'redirection' => 0,
			'user-agent'  => $headers['User-Agent'],
			'headers'     => $headers,
		);
		if ( 'GET' === $method || 'DELETE' === $method ) {
			if ( array() !== $body ) {
				$url = add_query_arg( rawurlencode_deep( $body ), $url );
			}
		} else {
			$args['headers']['Content-Type'] = 'application/json';
			// An empty object, not an empty body: the API rejects an empty JSON body.
			$args['body'] = array() === $body ? '{}' : (string) wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			self::log( $method, $path, $headers, null, $response->get_error_code(), $response->get_error_message(), null );
			return new WP_Error(
				'tendr_unreachable',
				__( 'Could not reach tendr. Check the site can make outgoing HTTPS requests, then try again.', 'tendr' ),
				array( 'status' => 0 )
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = (string) wp_remote_retrieve_body( $response );
		$data   = '' === $raw ? array() : json_decode( $raw, true );

		if ( $status >= 200 && $status < 300 ) {
			if ( ! is_array( $data ) ) {
				self::log( $method, $path, $headers, $status, 'tendr_bad_response', 'Response was not JSON', null );
				return new WP_Error( 'tendr_bad_response', __( 'tendr sent a response this plugin could not read. Try again.', 'tendr' ), array( 'status' => $status ) );
			}
			return $data;
		}

		$error   = ( is_array( $data ) && isset( $data['error'] ) && is_array( $data['error'] ) ) ? $data['error'] : array();
		$code    = ( isset( $error['code'] ) && is_string( $error['code'] ) && preg_match( '/^[A-Z][A-Z0-9_]{0,63}$/', $error['code'] ) ) ? $error['code'] : 'tendr_http_' . $status;
		$message = ( isset( $error['message'] ) && is_string( $error['message'] ) && '' !== $error['message'] )
			? self::scrub( wp_strip_all_tags( $error['message'] ) )
			/* translators: %d: HTTP status code. */
			: sprintf( __( 'tendr returned an error (HTTP %d). Try again.', 'tendr' ), $status );
		$request_id = ( isset( $error['requestId'] ) && is_string( $error['requestId'] ) ) ? $error['requestId'] : null;

		self::log( $method, $path, $headers, $status, $code, $message, $request_id );

		$error_data = array(
			'status'     => $status,
			'request_id' => $request_id,
		);
		// Two short machine-readable details the plugin acts on (e.g. `field: amount`,
		// `reason: deposit_in_progress`); nothing else from `details` is kept.
		$details = ( isset( $error['details'] ) && is_array( $error['details'] ) ) ? $error['details'] : array();
		foreach ( array( 'field', 'reason' ) as $key ) {
			if ( isset( $details[ $key ] ) && is_string( $details[ $key ] ) && preg_match( '/^[a-z][a-z0-9_]{0,63}$/', $details[ $key ] ) ) {
				$error_data[ $key ] = $details[ $key ];
			}
		}

		return new WP_Error( $code, $message, $error_data );
	}

	/**
	 * Headers with Authorization replaced by `[redacted]`.
	 *
	 * @param array $headers Headers.
	 */
	public static function redact_headers( array $headers ): array {
		foreach ( $headers as $name => $value ) {
			if ( 0 === strcasecmp( (string) $name, 'Authorization' ) ) {
				$headers[ $name ] = '[redacted]';
			} elseif ( is_string( $value ) ) {
				$headers[ $name ] = self::scrub( $value );
			}
		}
		return $headers;
	}

	/**
	 * Text with anything shaped like a tendr key or webhook secret replaced by `[redacted]`.
	 *
	 * @param string $text Text.
	 */
	public static function scrub( string $text ): string {
		return (string) preg_replace( self::SECRET_PATTERN, '[redacted]', $text );
	}

	/**
	 * Log a failed call (WooCommerce logger, source `tendr`) and fire `tendr_api_log`.
	 *
	 * @param string      $method     Method.
	 * @param string      $path       Path.
	 * @param array       $headers    Request headers (redacted here).
	 * @param int|null    $status     HTTP status, or null for a transport error.
	 * @param string      $code       Error code.
	 * @param string      $message    Error message.
	 * @param string|null $request_id API request id.
	 */
	private static function log( string $method, string $path, array $headers, ?int $status, string $code, string $message, ?string $request_id ): void {
		$entry = array(
			'method'     => $method,
			'path'       => self::scrub( $path ),
			'status'     => $status,
			'code'       => self::scrub( $code ),
			'message'    => self::scrub( $message ),
			'request_id' => $request_id,
			'headers'    => self::redact_headers( $headers ),
		);

		/**
		 * A failed tendr API call, already redacted.
		 *
		 * @param array $entry method, path, status, code, message, request_id, headers.
		 */
		do_action( 'tendr_api_log', $entry );

		if ( function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->warning(
				sprintf( 'tendr API %s %s failed: %s %s', $method, $entry['path'], $entry['code'], $entry['message'] ),
				array(
					'source' => 'tendr',
					'tendr'  => $entry,
				)
			);
		}
	}
}
