<?php
/**
 * `GET /wp-json/tendr/v1/order-status/{order_key}`.
 *
 * @package Tendr
 */

/**
 * Tendr_Order_Status.
 */
class OrderStatusTest extends Tendr_Test_Case {

	/**
	 * A pending order.
	 *
	 * @param string $method Payment method.
	 */
	private static function order( string $method = 'tendr' ): WC_Order {
		$order = wc_create_order();
		$order->set_payment_method( $method );
		$order->set_total( '10.00' );
		$order->set_status( 'pending' );
		$order->save();
		return $order;
	}

	/**
	 * GET the route.
	 *
	 * @param string $key Order key.
	 */
	private static function get( string $key ): WP_REST_Response {
		return rest_do_request( new WP_REST_Request( 'GET', '/tendr/v1/order-status/' . $key ) );
	}

	public function test_order_status_returns_status_only_and_404_for_wrong_key(): void {
		$order = self::order();

		$ok = self::get( $order->get_order_key() );
		$this->assertSame( 200, $ok->get_status() );
		$this->assertSame( array( 'status' => 'pending' ), $ok->get_data() );
		$this->assertSame( 'no-store', $ok->get_headers()['Cache-Control'] ?? null );

		$order->update_status( 'processing' );
		$this->assertSame( array( 'status' => 'processing' ), self::get( $order->get_order_key() )->get_data() );

		$unknown  = self::get( 'wc_order_doesnotexist000' );
		$mismatch = self::get( strtoupper( $order->get_order_key() ) ); // The DB lookup is case-insensitive.
		$this->assertSame( 404, $unknown->get_status() );
		$this->assertSame( 404, $mismatch->get_status() );
		$this->assertSame( $unknown->get_data(), $mismatch->get_data(), 'no difference between no order and a wrong key' );
	}

	public function test_orders_paid_another_way_are_not_reported(): void {
		$order = self::order( 'bacs' );
		$this->assertSame( 404, self::get( $order->get_order_key() )->get_status() );
	}

	public function test_route_is_public_and_read_only(): void {
		$routes = rest_get_server()->get_routes();
		$route  = '/tendr/v1/order-status/(?P<order_key>[A-Za-z0-9_]{1,64})';
		$this->assertArrayHasKey( $route, $routes );
		$this->assertSame( array( 'GET' => true ), $routes[ $route ][0]['methods'] );

		$order = self::order();
		$post  = rest_do_request( new WP_REST_Request( 'POST', '/tendr/v1/order-status/' . $order->get_order_key() ) );
		$this->assertSame( 404, $post->get_status() );
	}
}
