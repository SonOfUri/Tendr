<?php
/**
 * "Make a test purchase" (spec §3): a test-mode order with a single 1.00 fee line and no product,
 * so the shop catalogue is untouched. Test orders carry `_tendr_test = yes`, show a "Test" badge
 * in the orders list, and can be removed with the bulk action "Delete tendr test orders", which
 * deletes only orders carrying that flag.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Test purchases.
 */
final class Tendr_Test_Purchase {

	const META        = '_tendr_test';
	const BULK_ACTION = 'tendr_delete_test_orders';
	const NONCE       = 'tendr_test_purchase';

	/**
	 * Hooks: the admin-post action, the orders list badge and bulk action (HPOS and legacy).
	 */
	public static function register(): void {
		add_action( 'admin_post_tendr_test_purchase', array( self::class, 'handle_request' ) );
		foreach ( array( 'woocommerce_page_wc-orders', 'edit-shop_order' ) as $screen ) {
			add_filter( 'bulk_actions-' . $screen, array( self::class, 'add_bulk_action' ) );
			add_filter( 'handle_bulk_actions-' . $screen, array( self::class, 'handle_bulk_action' ), 10, 3 );
		}
		add_action( 'manage_woocommerce_page_wc-orders_custom_column', array( self::class, 'render_column' ), 20, 2 );
		add_action( 'manage_shop_order_posts_custom_column', array( self::class, 'render_legacy_column' ), 20, 2 );
		add_action( 'admin_notices', array( self::class, 'deleted_notice' ) );
	}

	/**
	 * Create the test order. Test mode only, for store managers.
	 *
	 * @return WC_Order|WP_Error
	 */
	public static function create() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return new WP_Error( 'tendr_forbidden', __( 'You are not allowed to do that.', 'tendr-pay-with-crypto' ) );
		}
		if ( ! Tendr_Connect::is_connected() ) {
			return new WP_Error( 'tendr_not_connected', __( 'Connect this site to tendr first.', 'tendr-pay-with-crypto' ) );
		}
		if ( 'test' !== Tendr_Connect::mode() ) {
			return new WP_Error( 'tendr_live_mode', __( 'Test purchases are made in test mode only. Switch to test mode first.', 'tendr-pay-with-crypto' ) );
		}

		$status = Tendr_Settings::connect_status( true, 'test' );
		if ( null !== $status['error'] || ! $status['ready'] || array() !== $status['blocking'] ) {
			return new WP_Error( 'tendr_test_not_ready', __( 'Your Test wallet is not ready or could not be checked. Open Tendr settings, follow the Test wallet setup links, then retry.', 'tendr-pay-with-crypto' ) );
		}

		$user  = wp_get_current_user();
		$order = wc_create_order(
			array(
				'customer_id' => $user->ID,
				'created_via' => 'tendr_test',
			)
		);
		if ( is_wp_error( $order ) ) {
			return $order;
		}
		// The checkout minimum is 1 USD; 1 unit of the store currency can fall below it.
		$order->set_currency( 'USD' );
		$fee = new WC_Order_Item_Fee();
		$fee->set_name( __( 'Tendr test payment', 'tendr-pay-with-crypto' ) );
		$fee->set_amount( '1.00' );
		$fee->set_total( '1.00' );
		$fee->set_tax_status( 'none' );
		$order->add_item( $fee );
		if ( is_email( $user->user_email ) ) {
			$order->set_billing_email( $user->user_email );
		}
		$order->set_payment_method( Tendr_Gateway::ID );
		$order->set_payment_method_title( __( 'Pay with crypto', 'tendr-pay-with-crypto' ) );
		$order->update_meta_data( self::META, 'yes' );
		$order->calculate_totals( false );
		$order->set_status( 'pending' );
		$order->save();
		$order->add_order_note( __( 'Tendr Test purchase: pay with Tidepool test USDC or USDT on the network shown in checkout. These tokens have no monetary value; the paying wallet needs test network fees.', 'tendr-pay-with-crypto' ) );
		return $order;
	}

	/**
	 * Where the admin pays the test order: its pay-for-order page.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function pay_url( WC_Order $order ): string {
		return $order->get_checkout_payment_url();
	}

	/**
	 * `admin-post.php?action=tendr_test_purchase` (POST, nonce, capability): create the order and
	 * open its pay page.
	 */
	public static function handle_request(): void {
		$nonce = isset( $_POST['tendr_test_purchase_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['tendr_test_purchase_nonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, self::NONCE ) || ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'tendr-pay-with-crypto' ), 403 );
		}
		$order = self::create();
		if ( is_wp_error( $order ) ) {
			Tendr_Settings::flash( 'error', $order->get_error_message() );
			wp_safe_redirect( Tendr_Settings::url() );
			exit;
		}
		wp_safe_redirect( self::pay_url( $order ) );
		exit;
	}

	/**
	 * Whether an order is a tendr test order.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function is_test( WC_Order $order ): bool {
		return 'yes' === $order->get_meta( self::META );
	}

	/**
	 * The "Test" badge next to the order number (HPOS orders list).
	 *
	 * @param string         $column Column.
	 * @param WC_Order|mixed $order  Order.
	 */
	public static function render_column( $column, $order ): void {
		if ( 'order_number' === $column && $order instanceof WC_Order && self::is_test( $order ) ) {
			echo ' <mark class="order-status tendr-test-badge" style="margin-left:4px;"><span>' . esc_html__( 'Test', 'tendr-pay-with-crypto' ) . '</span></mark>';
		}
	}

	/**
	 * The badge on the legacy (posts) orders list.
	 *
	 * @param string $column  Column.
	 * @param int    $post_id Order id.
	 */
	public static function render_legacy_column( $column, $post_id ): void {
		if ( 'order_number' !== $column ) {
			return;
		}
		$order = wc_get_order( $post_id );
		if ( $order instanceof WC_Order ) {
			self::render_column( $column, $order );
		}
	}

	/**
	 * Add "Delete tendr test orders" to the orders list bulk actions.
	 *
	 * @param array $actions Bulk actions.
	 */
	public static function add_bulk_action( $actions ): array {
		$actions                      = is_array( $actions ) ? $actions : array();
		$actions[ self::BULK_ACTION ] = __( 'Delete tendr test orders', 'tendr-pay-with-crypto' );
		return $actions;
	}

	/**
	 * Run "Delete tendr test orders" on the selected orders: only those flagged `_tendr_test = yes`
	 * are deleted. The orders list checked its own nonce before this filter; it is checked again
	 * here, with the capability.
	 *
	 * @param string $redirect Redirect URL.
	 * @param string $action   Bulk action.
	 * @param array  $ids      Selected order ids.
	 */
	public static function handle_bulk_action( $redirect, $action, $ids ) {
		if ( self::BULK_ACTION !== $action ) {
			return $redirect;
		}
		$nonce = isset( $_REQUEST['_wpnonce'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['_wpnonce'] ) ) : '';
		if ( ! current_user_can( 'manage_woocommerce' ) || ( ! wp_verify_nonce( $nonce, 'bulk-orders' ) && ! wp_verify_nonce( $nonce, 'bulk-posts' ) ) ) {
			return $redirect;
		}
		$deleted = self::delete_test_orders( array_map( 'absint', (array) $ids ) );
		return add_query_arg( 'tendr_test_deleted', $deleted, $redirect );
	}

	/**
	 * Delete the tendr test orders among `$ids`; every other order is left alone.
	 *
	 * @param int[] $ids Order ids.
	 * @return int How many were deleted.
	 */
	public static function delete_test_orders( array $ids ): int {
		$ids = array_values( array_filter( array_unique( $ids ) ) );
		if ( array() === $ids ) {
			return 0;
		}
		// Through WooCommerce's order objects, so it works with HPOS and with posts storage.
		$count = 0;
		foreach ( $ids as $id ) {
			$order = wc_get_order( $id );
			if ( $order instanceof WC_Order && 'shop_order' === $order->get_type() && self::is_test( $order ) && $order->delete( true ) ) {
				++$count;
			}
		}
		return $count;
	}

	/**
	 * After the bulk action: how many test orders were deleted.
	 */
	public static function deleted_notice(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- a count for display only.
		if ( ! isset( $_GET['tendr_test_deleted'] ) || ! current_user_can( 'manage_woocommerce' ) ) {
			return;
		}
		$count = absint( $_GET['tendr_test_deleted'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		echo '<div class="notice notice-success is-dismissible"><p>' . esc_html(
			sprintf(
				/* translators: %d: number of orders. */
				_n( '%d tendr test order deleted.', '%d tendr test orders deleted.', $count, 'tendr-pay-with-crypto' ),
				$count
			)
		) . '</p></div>';
	}
}
