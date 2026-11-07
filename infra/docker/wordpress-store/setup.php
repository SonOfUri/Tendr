<?php
// Disposable store content only. Never creates a Tendr connection or authorizes money movement.
if ( get_option( 'tendr_docker_store_initialized' ) ) {
    WP_CLI::success( 'Existing store retained.' );
    return;
}

update_option( 'blogdescription', 'A WooCommerce store for testing Tendr checkout.' );
update_option( 'blog_public', '0' );
update_option( 'woocommerce_currency', 'USD' );
update_option( 'woocommerce_default_country', 'NG:LA' );
update_option( 'woocommerce_enable_guest_checkout', 'yes' );
update_option( 'woocommerce_allow_tracking', 'no' );
update_option( 'woocommerce_show_marketplace_suggestions', 'no' );
update_option( 'woocommerce_task_list_hidden', 'yes' );
update_option( 'woocommerce_onboarding_profile', array( 'skipped' => true ) );
update_option( 'woocommerce_coming_soon', 'no' );
WC_Install::create_pages();
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', wc_get_page_id( 'shop' ) );

$product = new WC_Product_Simple();
$product->set_name( 'Tendr checkout test' );
$product->set_slug( 'tendr-checkout-test' );
$product->set_sku( 'TENDR-DOCKER-TEST' );
$product->set_status( 'publish' );
$product->set_virtual( true );
$product->set_regular_price( '1.00' );
$product->set_description( 'A $1 virtual test item for trying your Tendr WooCommerce integration. No physical item will be shipped.' );
$product->save();

update_option( 'tendr_docker_store_initialized', true );
WP_CLI::success( 'Store and $1 virtual product created; Tendr still needs your Connect approval.' );
