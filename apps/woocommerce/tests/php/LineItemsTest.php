<?php
/**
 * The order's products sent with a checkout session.
 *
 * @package Tendr
 */

/**
 * Tendr_Gateway line items.
 */
class LineItemsTest extends Tendr_Test_Case {

	/**
	 * An order with `$count` products priced 10.00 each (quantity 1).
	 *
	 * @param int $count Items.
	 */
	private static function order_with_items( int $count ): WC_Order {
		$order = wc_create_order();
		$order->set_currency( 'NGN' );
		for ( $i = 1; $i <= $count; $i++ ) {
			$product = new WC_Product_Simple();
			$product->set_name( "Item {$i}" );
			$product->set_regular_price( '10.00' );
			$product->save();
			$order->add_product( $product, 1 );
		}
		$order->calculate_totals();
		$order->save();
		return $order;
	}

	public function test_truncates_to_50_items(): void {
		$order = self::order_with_items( 60 );
		$items = Tendr_Gateway::line_items( $order );
		$this->assertCount( 50, $items );
		$this->assertSame( 'Item 1', $items[0]['name'] );
		$this->assertSame( 'Item 50', $items[49]['name'] );

		$body = ( new Tendr_Gateway() )->session_body( $order );
		$this->assertCount( 50, $body['line_items'] );
	}

	public function test_line_item_unit_amounts_use_store_decimals(): void {
		$order = wc_create_order();
		$order->set_currency( 'NGN' );
		$third = new WC_Order_Item_Product();
		$third->set_name( 'Three for ten' );
		$third->set_quantity( 3 );
		$third->set_total( '10.00' );
		$order->add_item( $third );
		$pair = new WC_Order_Item_Product();
		$pair->set_name( 'Plain' );
		$pair->set_quantity( 2 );
		$pair->set_total( '25.00' );
		$order->add_item( $pair );
		$order->save();

		$items = Tendr_Gateway::line_items( $order );
		$this->assertSame( '3.33', $items[0]['unit_amount'], 'rounded to the 2 store decimals' );
		$this->assertSame( 3, $items[0]['quantity'] );
		$this->assertSame( '12.5', $items[1]['unit_amount'], 'no trailing zero, like the order amount' );

		update_option( 'woocommerce_price_num_decimals', '0' );
		$items = Tendr_Gateway::line_items( $order );
		$this->assertSame( '3', $items[0]['unit_amount'] );
		$this->assertSame( '13', $items[1]['unit_amount'] );
	}

	public function test_skips_non_https_images(): void {
		$order   = wc_create_order();
		$product = new WC_Product_Simple();
		$product->set_name( 'With image' );
		$product->set_regular_price( '5' );
		$product->save();
		$product->set_image_id( self::factory()->attachment->create_upload_object( DIR_TESTDATA . '/images/canola.jpg' ) );
		$product->save();
		$order->add_product( $product, 1 );
		$order->save();

		$this->assertStringStartsWith( 'http://', (string) wp_get_attachment_image_url( $product->get_image_id(), 'full' ), 'the test site is plain http' );
		$this->assertArrayNotHasKey( 'image_url', Tendr_Gateway::line_items( $order )[0], 'http image dropped' );

		add_filter( 'wp_get_attachment_url', static fn( $url ) => preg_replace( '#^http://#', 'https://', (string) $url ) );
		$items = Tendr_Gateway::line_items( $order );
		$this->assertStringStartsWith( 'https://', $items[0]['image_url'] );
	}

	public function test_an_order_without_products_sends_no_line_items(): void {
		$order = wc_create_order();
		$order->set_total( '1.00' );
		$order->save();
		$this->assertArrayNotHasKey( 'line_items', ( new Tendr_Gateway() )->session_body( $order ) );
	}

	public function test_names_are_cut_to_200_characters(): void {
		$order = wc_create_order();
		$item  = new WC_Order_Item_Product();
		$item->set_name( str_repeat( 'é', 300 ) );
		$item->set_quantity( 1 );
		$item->set_total( '1.00' );
		$order->add_item( $item );
		$order->save();
		$this->assertSame( 200, mb_strlen( Tendr_Gateway::line_items( $order )[0]['name'] ) );
	}
}
