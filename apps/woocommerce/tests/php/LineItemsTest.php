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

	/**
	 * An order with one line.
	 *
	 * @param string $name     Name.
	 * @param float  $quantity Quantity.
	 * @param string $total    Line total.
	 */
	private static function order_with_line( string $name, float $quantity, string $total ): WC_Order {
		$order = wc_create_order();
		$item  = new WC_Order_Item_Product();
		$item->set_name( $name );
		$item->set_quantity( $quantity );
		$item->set_total( $total );
		$order->add_item( $item );
		$order->save();
		return $order;
	}

	public function test_line_item_unit_amounts_use_store_decimals(): void {
		// Exact division in minor units: 25.00 / 2 = 12.50, trailing zero trimmed like the order amount.
		$line = Tendr_Gateway::line_items( self::order_with_line( 'Pair', 2, '25.00' ) )[0];
		$this->assertSame( 2, $line['quantity'] );
		$this->assertSame( '12.5', $line['unit_amount'] );

		// A JPY store with 2 price decimals, 3 for 1000: not divisible, so one unit at the line total
		// (never "333.33", which the API refuses for JPY).
		$line = Tendr_Gateway::line_items( self::order_with_line( 'Tee', 3, '1000.00' ) )[0];
		$this->assertSame( 1, $line['quantity'] );
		$this->assertSame( 'Tee × 3', $line['name'] );
		$this->assertSame( '1000', $line['unit_amount'] );

		// 3 for 999.00 divides exactly: 333.
		$line = Tendr_Gateway::line_items( self::order_with_line( 'Tee', 3, '999.00' ) )[0];
		$this->assertSame( array( 3, '333' ), array( $line['quantity'], $line['unit_amount'] ) );

		// A 3-decimal store (USD only allows 2): 3 for 1.500 divides to 0.5 (fine); 3 for 1.000 does not.
		update_option( 'woocommerce_price_num_decimals', '3' );
		$line = Tendr_Gateway::line_items( self::order_with_line( 'Gum', 3, '1.500' ) )[0];
		$this->assertSame( array( 3, '0.5' ), array( $line['quantity'], $line['unit_amount'] ) );
		$line = Tendr_Gateway::line_items( self::order_with_line( 'Gum', 3, '1.000' ) )[0];
		$this->assertSame( array( 1, 'Gum × 3', '1' ), array( $line['quantity'], $line['name'], $line['unit_amount'] ) );

		update_option( 'woocommerce_price_num_decimals', '0' );
		$line = Tendr_Gateway::line_items( self::order_with_line( 'Tee', 3, '10' ) )[0];
		$this->assertSame( array( 1, '10' ), array( $line['quantity'], $line['unit_amount'] ) );
	}

	public function test_fractional_and_out_of_range_quantities_keep_the_line_total(): void {
		// Stores that sell by length or weight can have decimal quantities (WooCommerce itself rounds
		// them down on an item, so the helper is called with the raw quantity).
		$line = Tendr_Gateway::priced_line( 'Cloth', 2.5, 25.0, 2 );
		$this->assertSame( array( 1, 'Cloth × 2.5', '25' ), array( $line['quantity'], $line['name'], $line['unit_amount'] ) );

		$line = Tendr_Gateway::line_items( self::order_with_line( 'Bolts', 20000, '200.00' ) )[0];
		$this->assertSame( array( 1, 'Bolts × 20000', '200' ), array( $line['quantity'], $line['name'], $line['unit_amount'] ) );
		$this->assertLessThanOrEqual( 200, mb_strlen( Tendr_Gateway::priced_line( str_repeat( 'a', 300 ), 2.5, 5.0, 2 )['name'] ) );
	}

	public function test_names_are_decoded_after_stripping_tags(): void {
		$line = Tendr_Gateway::line_items( self::order_with_line( '<b>Tom &amp; Jerry&#039;s</b>', 1, '5' ) )[0];
		$this->assertSame( "Tom & Jerry's", $line['name'] );
	}

	/**
	 * Refusal messages that do and do not name `line_items`: either way the body is retried once
	 * without them.
	 *
	 * @return array<string, array{0: string}>
	 */
	public static function validation_messages(): array {
		return array(
			'names line_items'  => array( 'line_items[0]: unit_amount in USD allows at most 2 decimal places' ),
			'names no field'    => array( 'The request body is invalid' ),
			'names other field' => array( 'description: too long' ),
		);
	}

	/**
	 * @dataProvider validation_messages
	 */
	public function test_a_session_refused_with_line_items_is_retried_without_them_on_a_new_key( string $message ): void {
		self::connect_locally();
		$order = self::order_with_items( 2 );
		$order->set_total( '20.00' );
		$order->save();
		$calls = 0;
		$this->mock_http(
			static function ( $url, $args ) use ( &$calls, $message ) {
				++$calls;
				$body = json_decode( (string) $args['body'], true );
				if ( isset( $body['line_items'] ) ) {
					return self::response(
						400,
						array(
							'error' => array(
								'code'    => 'VALIDATION_ERROR',
								'message' => $message,
								'details' => array( 'field' => 'line_items.0.unit_amount' ),
							),
						)
					);
				}
				return self::response(
					201,
					array(
						'id'            => 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0',
						'client_secret' => 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0_secret_0123456789abcdef0123456789abcdef',
						'url'           => 'https://usetendr.tech/pay/ses_01JABCDEFGHJKMNPQRSTVWXYZ0#cs=ses_01JABCDEFGHJKMNPQRSTVWXYZ0_secret_0123456789abcdef0123456789abcdef',
						'expires_at'    => gmdate( 'c', time() + 600 ),
						'status'        => 'PENDING_DEPOSIT',
					)
				);
			}
		);

		$result = ( new Tendr_Gateway() )->process_payment( $order->get_id() );

		$this->assertSame( 'success', $result['result'] );
		$this->assertSame( 2, $calls );
		$ref = Tendr_Gateway::external_ref( $order->get_id() );
		$this->assertSame( $ref . '-1', $this->requests[0]['args']['headers']['Idempotency-Key'] );
		$this->assertSame( $ref . '-2', $this->requests[1]['args']['headers']['Idempotency-Key'], 'the refused call used its key up' );
		$this->assertArrayNotHasKey( 'line_items', json_decode( (string) $this->requests[1]['args']['body'], true ) );
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
