<?php
/**
 * "Make a test purchase" and the test-order clean-up (spec §3).
 *
 * @package Tendr
 */

/**
 * Tendr_Test_Purchase.
 */
class TestPurchaseTest extends Tendr_Test_Case {

	public function set_up(): void {
		parent::set_up();
		self::connect_locally();
		$this->login_admin();
		update_option( 'woocommerce_currency', 'EUR' );
	}

	public function tear_down(): void {
		unset( $_REQUEST['_wpnonce'], $_POST['tendr_test_purchase_nonce'] );
		parent::tear_down();
	}

	public function test_test_purchase_creates_fee_only_order_flagged_test_not_in_catalogue(): void {
		$products_before = wp_count_posts( 'product' );

		$order = Tendr_Test_Purchase::create();

		$this->assertInstanceOf( WC_Order::class, $order );
		$order = wc_get_order( $order->get_id() );
		$this->assertSame( 'yes', $order->get_meta( Tendr_Test_Purchase::META ) );
		$this->assertSame( 'pending', $order->get_status() );
		$this->assertSame( 'tendr', $order->get_payment_method() );
		$this->assertSame( 'EUR', $order->get_currency() );
		$this->assertSame( array(), $order->get_items( 'line_item' ), 'no products' );
		$fees = array_values( $order->get_items( 'fee' ) );
		$this->assertCount( 1, $fees );
		$this->assertSame( 'Tendr test payment', $fees[0]->get_name() );
		$this->assertEquals( 1.00, (float) $fees[0]->get_total() );
		$this->assertEquals( 1.00, (float) $order->get_total() );
		$this->assertSame( get_current_user_id(), $order->get_customer_id(), 'the admin can open its pay page' );
		$this->assertEquals( $products_before, wp_count_posts( 'product' ), 'nothing added to the catalogue' );

		$this->assertSame( $order->get_checkout_payment_url(), Tendr_Test_Purchase::pay_url( $order ) );
	}

	public function test_test_purchase_is_refused_in_live_mode(): void {
		update_option( Tendr_Connect::MODE, 'live' );
		$this->assertWPError( Tendr_Test_Purchase::create() );
	}

	public function test_test_purchase_is_refused_without_the_capability(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );
		$this->assertWPError( Tendr_Test_Purchase::create() );
	}

	public function test_test_purchase_request_needs_a_nonce(): void {
		$_POST['tendr_test_purchase_nonce'] = 'bad';
		try {
			Tendr_Test_Purchase::handle_request();
			$this->fail( 'a bad nonce must stop the request' );
		} catch ( WPDieException $e ) {
			$this->assertSame( array(), wc_get_orders( array( 'limit' => -1 ) ) );
		}
	}

	public function test_orders_list_shows_a_test_badge(): void {
		$test = Tendr_Test_Purchase::create();
		$real = wc_create_order();

		ob_start();
		Tendr_Test_Purchase::render_column( 'order_number', $test );
		$badge = (string) ob_get_clean();
		ob_start();
		Tendr_Test_Purchase::render_column( 'order_number', $real );
		$none = (string) ob_get_clean();
		ob_start();
		Tendr_Test_Purchase::render_legacy_column( 'order_number', $test->get_id() );
		$legacy = (string) ob_get_clean();

		$this->assertStringContainsString( 'Test', $badge );
		$this->assertSame( '', $none );
		$this->assertStringContainsString( 'Test', $legacy );
	}

	public function test_bulk_action_is_offered_on_both_order_screens(): void {
		$actions = Tendr_Test_Purchase::add_bulk_action( array() );
		$this->assertArrayHasKey( Tendr_Test_Purchase::BULK_ACTION, $actions );
		$this->assertSame( 'Delete tendr test orders', $actions[ Tendr_Test_Purchase::BULK_ACTION ] );
		$this->assertNotFalse( has_filter( 'bulk_actions-woocommerce_page_wc-orders', array( Tendr_Test_Purchase::class, 'add_bulk_action' ) ) );
		$this->assertNotFalse( has_filter( 'bulk_actions-edit-shop_order', array( Tendr_Test_Purchase::class, 'add_bulk_action' ) ) );
	}

	public function test_bulk_delete_removes_only_test_orders(): void {
		$test_a = Tendr_Test_Purchase::create();
		$test_b = Tendr_Test_Purchase::create();
		$real   = wc_create_order();
		$fake   = wc_create_order();
		$fake->update_meta_data( Tendr_Test_Purchase::META, 'no' );
		$fake->save();

		$_REQUEST['_wpnonce'] = wp_create_nonce( 'bulk-orders' );
		$redirect             = Tendr_Test_Purchase::handle_bulk_action(
			'https://example.org/wp-admin/admin.php?page=wc-orders',
			Tendr_Test_Purchase::BULK_ACTION,
			array( $test_a->get_id(), $test_b->get_id(), $real->get_id(), $fake->get_id() )
		);

		$this->assertFalse( wc_get_order( $test_a->get_id() ) );
		$this->assertFalse( wc_get_order( $test_b->get_id() ) );
		$this->assertInstanceOf( WC_Order::class, wc_get_order( $real->get_id() ) );
		$this->assertInstanceOf( WC_Order::class, wc_get_order( $fake->get_id() ) );
		$this->assertStringContainsString( 'tendr_test_deleted=2', $redirect );
	}

	public function test_bulk_delete_needs_the_capability_and_a_nonce(): void {
		$test = Tendr_Test_Purchase::create();

		// No nonce.
		Tendr_Test_Purchase::handle_bulk_action( 'https://example.org/', Tendr_Test_Purchase::BULK_ACTION, array( $test->get_id() ) );
		$this->assertInstanceOf( WC_Order::class, wc_get_order( $test->get_id() ) );

		// A nonce, but no capability.
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'customer' ) ) );
		$_REQUEST['_wpnonce'] = wp_create_nonce( 'bulk-orders' );
		Tendr_Test_Purchase::handle_bulk_action( 'https://example.org/', Tendr_Test_Purchase::BULK_ACTION, array( $test->get_id() ) );
		$this->assertInstanceOf( WC_Order::class, wc_get_order( $test->get_id() ) );
	}

	public function test_other_bulk_actions_are_left_alone(): void {
		$test                 = Tendr_Test_Purchase::create();
		$_REQUEST['_wpnonce'] = wp_create_nonce( 'bulk-orders' );
		$this->assertSame( 'x', Tendr_Test_Purchase::handle_bulk_action( 'x', 'mark_completed', array( $test->get_id() ) ) );
		$this->assertInstanceOf( WC_Order::class, wc_get_order( $test->get_id() ) );
	}

	public function test_settings_page_offers_the_test_purchase_in_test_mode_only(): void {
		$this->mock_http( fn() => self::response( 503, null ) );
		$this->assertStringContainsString( 'Make a test purchase', Tendr_Settings::render() );
		update_option( Tendr_Connect::MODE, 'live' );
		$this->assertStringNotContainsString( 'Make a test purchase', Tendr_Settings::render() );
	}
}
