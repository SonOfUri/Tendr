<?php
/**
 * `GET /wp-json/tendr/v1/order-status/{order_key}`: the thank-you page's poll. Public, read only;
 * the order key (already in the thank-you URL) is the credential. It answers `{ "status": … }`
 * for a tendr order and nothing else, and the same 404 for an unknown key, a key that only
 * matches case-insensitively, and an order paid another way.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * The order-status endpoint.
 */
final class Tendr_Order_Status {

	const NAMESPACE = 'tendr/v1';
	const ROUTE     = '/order-status/(?P<order_key>[A-Za-z0-9_]{1,64})';

	/**
	 * Hook the route.
	 */
	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
	}

	/**
	 * `rest_api_init`.
	 */
	public static function register_routes(): void {
		register_rest_route(
			self::NAMESPACE,
			self::ROUTE,
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( self::class, 'handle' ),
				// Public: the order key authenticates the request (checked in handle()).
				'permission_callback' => '__return_true',
				'args'                => array(
					'order_key' => array(
						'type'     => 'string',
						'required' => true,
					),
				),
			)
		);
	}

	/**
	 * The order's status, or 404.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function handle( WP_REST_Request $request ) {
		$key   = (string) $request->get_param( 'order_key' );
		$order = self::order_for_key( $key );
		if ( null === $order ) {
			return new WP_Error( 'tendr_order_not_found', __( 'Order not found.', 'tendr' ), array( 'status' => 404 ) );
		}
		$response = new WP_REST_Response( array( 'status' => $order->get_status() ), 200 );
		$response->header( 'Cache-Control', 'no-store' );
		return $response;
	}

	/**
	 * The tendr order whose key is exactly `$key` (constant-time comparison), or null.
	 *
	 * @param string $key Order key.
	 */
	private static function order_for_key( string $key ): ?WC_Order {
		if ( '' === $key ) {
			return null;
		}
		$order_id = wc_get_order_id_by_order_key( $key );
		$order    = $order_id ? wc_get_order( $order_id ) : false;
		if ( ! $order instanceof WC_Order ) {
			return null;
		}
		// The lookup is a case-insensitive database match; the key must be exact.
		if ( ! hash_equals( (string) $order->get_order_key(), $key ) ) {
			return null;
		}
		if ( Tendr_Gateway::ID !== $order->get_payment_method() ) {
			return null;
		}
		return $order;
	}
}
