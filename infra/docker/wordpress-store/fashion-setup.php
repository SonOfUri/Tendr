<?php
/** Idempotent seed for the explicitly labelled, local fashion concept store. */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) { exit; }
if ( ! class_exists( 'WooCommerce' ) ) { WP_CLI::error( 'Run npm run dev:wordpress first.' ); }

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

// Keep complete garments visible in product grids instead of WooCommerce's square crop.
update_option( 'woocommerce_thumbnail_cropping', 'uncropped' );
update_option( 'woocommerce_thumbnail_image_width', 600 );
update_option( 'woocommerce_single_image_width', 1000 );
$refresh_images = get_option( 'tendr_fashion_image_version' ) !== '1';

$catalog = array(
    array( 'knit', 'Ribbed knit sweater', '49.00', 'Ecru', '#eee6d5', array( 'woman', 'man', 'essentials' ), 'A relaxed silhouette with a substantial ribbed texture, dropped shoulders, and softly turned cuffs.', 'Relaxed fit. Choose your usual size for an easy silhouette.' ),
    array( 'overshirt', 'Linen-blend overshirt', '69.00', 'Sand', '#b8a385', array( 'man', 'essentials' ), 'An airy textured overshirt with patch pockets, a relaxed collar, and an effortless straight cut.', 'Relaxed fit. Wear open over a tee or buttoned as a light layer.' ),
    array( 'trousers', 'Wide-leg tailored trousers', '59.00', 'Black', '#242424', array( 'woman', 'man' ), 'Clean lines and a fluid wide leg. Double pleats add shape to an understated everyday staple.', 'Relaxed through the leg with a structured waistband.' ),
    array( 'dress', 'Draped jersey dress', '89.00', 'Chocolate', '#503327', array( 'woman' ), 'A fluid long-sleeve silhouette, shaped with asymmetric gathering at the waist and a softly draped maxi hem.', 'Regular fit with a draped waist. Maxi length.' ),
    array( 'coat', 'Oversized wool-blend coat', '139.00', 'Camel', '#b08a61', array( 'woman', 'man' ), 'A generous tailored layer with broad lapels, a double-breasted front, and a beautifully uncomplicated line.', 'Oversized fit. Designed for layering over knitwear.' ),
    array( 'tee', 'Heavyweight cotton T-shirt', '29.00', 'Off-white', '#eae6dc', array( 'woman', 'man', 'essentials' ), 'A considered essential with a boxy cut, a substantial cotton feel, and a clean ribbed neckline.', 'Boxy fit. Slightly dropped shoulder and straight hem.' ),
);

$categories = array();
foreach ( array( 'woman' => 'Woman', 'man' => 'Man', 'essentials' => 'Essentials' ) as $slug => $label ) {
    $term = term_exists( $slug, 'product_cat' );
    if ( ! $term ) { $term = wp_insert_term( $label, 'product_cat', array( 'slug' => $slug ) ); }
    if ( is_wp_error( $term ) ) { WP_CLI::error( $term->get_error_message() ); }
    $categories[ $slug ] = (int) ( is_array( $term ) ? $term['term_id'] : $term );
}

$images = get_option( 'tendr_fashion_images', array() );
foreach ( $catalog as $index => $item ) {
    list( $slug, $name, $price, $color, $swatch, $groups, $description, $fit ) = $item;
    if ( empty( $images[ $slug ] ) || ! get_attached_file( $images[ $slug ] ) || ! file_exists( get_attached_file( $images[ $slug ] ) ) ) {
        $source = WP_CONTENT_DIR . '/themes/tendr-fashion/assets/' . $slug . '.webp';
        $temp = wp_tempnam( $slug . '.webp' );
        if ( ! copy( $source, $temp ) ) { WP_CLI::error( 'Cannot copy product image: ' . $slug ); }
        $image = media_handle_sideload( array( 'name' => $slug . '.webp', 'tmp_name' => $temp ), 0, $name );
        if ( is_wp_error( $image ) ) { WP_CLI::error( $image->get_error_message() ); }
        $images[ $slug ] = $image;
        update_post_meta( $image, '_wp_attachment_image_alt', $name . ' in ' . strtolower( $color ) . ' on a neutral studio background' );
        update_option( 'tendr_fashion_images', $images, false );
    }
    if ( $refresh_images ) {
        $metadata = wp_generate_attachment_metadata( $images[ $slug ], get_attached_file( $images[ $slug ] ) );
        if ( ! empty( $metadata ) ) { wp_update_attachment_metadata( $images[ $slug ], $metadata ); }
    }
    $sku = 'TENDR-FASHION-' . strtoupper( $slug );
    $id = wc_get_product_id_by_sku( $sku );
    $product = $id ? wc_get_product( $id ) : new WC_Product_Variable();
    if ( ! $product instanceof WC_Product_Variable ) { WP_CLI::error( 'Unexpected product type for ' . $sku ); }
    $product->set_name( $name );
    $product->set_slug( $slug . '-edit' );
    $product->set_sku( $sku );
    $product->set_status( 'publish' );
    $product->set_catalog_visibility( 'visible' );
    $product->set_featured( $index < 4 );
    $product->set_menu_order( $index );
    $product->set_image_id( $images[ $slug ] );
    $product->set_category_ids( array_map( function( $group ) use ( $categories ) { return $categories[ $group ]; }, $groups ) );
    $product->set_short_description( '<p>' . esc_html( $description ) . '</p>' );
    $product->set_description( '<h3>Details &amp; fit</h3><p>' . esc_html( $fit ) . '</p><p>Color: ' . esc_html( $color ) . '. Available in XS, S, M, L, and XL.</p><h3>About this item</h3><p>This is an original concept product created for an unofficial Zara-inspired Tendr demonstration. The photography is generated and the price is illustrative. No physical product will be delivered.</p>' );
    $product->set_reviews_allowed( false );
    $product->update_meta_data( '_tendr_fashion_color', $color );
    $product->update_meta_data( '_tendr_fashion_swatch', $swatch );
    $size = new WC_Product_Attribute();
    $size->set_name( 'Size' );
    $size->set_options( array( 'XS', 'S', 'M', 'L', 'XL' ) );
    $size->set_visible( true );
    $size->set_variation( true );
    $color_attribute = new WC_Product_Attribute();
    $color_attribute->set_name( 'Color' );
    $color_attribute->set_options( array( $color ) );
    $color_attribute->set_visible( true );
    $product->set_attributes( array( $size, $color_attribute ) );
    $product->save();
    foreach ( array( 'XS', 'S', 'M', 'L', 'XL' ) as $position => $label ) {
        $variation_sku = $sku . '-' . $label;
        $variation_id = wc_get_product_id_by_sku( $variation_sku );
        $variation = $variation_id ? wc_get_product( $variation_id ) : new WC_Product_Variation();
        $variation->set_parent_id( $product->get_id() );
        $variation->set_sku( $variation_sku );
        $variation->set_status( 'publish' );
        $variation->set_attributes( array( 'size' => $label ) );
        $variation->set_regular_price( $price );
        $variation->set_virtual( true );
        $variation->set_manage_stock( false );
        $variation->set_stock_status( 'instock' );
        $variation->set_menu_order( $position );
        $variation->save();
    }
    WC_Product_Variable::sync( $product->get_id() );
    wc_delete_product_transients( $product->get_id() );
}
update_option( 'tendr_fashion_image_version', '1', false );

// Keep the existing low-value payment test accessible through its permalink and footer link.
$test_id = wc_get_product_id_by_sku( 'TENDR-DOCKER-TEST' );
if ( $test_id ) {
    $test_product = wc_get_product( $test_id );
    $test_product->set_catalog_visibility( 'hidden' );
    $test_product->save();
}

function tendr_fashion_seed_page( $slug, $title, $content ) {
    $existing = get_page_by_path( $slug );
    $id = wp_insert_post( array( 'ID' => $existing ? $existing->ID : 0, 'post_title' => $title, 'post_name' => $slug, 'post_type' => 'page', 'post_status' => 'publish', 'post_content' => $content, 'comment_status' => 'closed' ), true );
    if ( is_wp_error( $id ) ) { WP_CLI::error( $id->get_error_message() ); }
    return $id;
}
$home = tendr_fashion_seed_page( 'the-everyday-edit', 'The Everyday Edit', '' );
tendr_fashion_seed_page( 'the-concept', 'A study in everyday dressing.', '<p>This independent concept store takes its visual cues from Zara’s editorial approach: considered silhouettes, quiet colors, and space for the clothes to speak.</p><h2>A real storefront. A demo collection.</h2><p>The six pieces, generated photography, and illustrative prices are created for this demonstration. This site is not affiliated with, endorsed by, or operated by Zara or Inditex. No physical goods are available or shipped.</p><h2>Experience the checkout</h2><p>Select a piece and your size, add it to your bag, and explore the WooCommerce checkout powered by Tendr. The payment mode is controlled by the store owner. Live mode transfers real funds; it does not turn these concept items into an actual clothing order.</p><p>For a small funded integration test, use the <a href="' . esc_url( wp_make_link_relative( home_url( '/product/tendr-checkout-test/' ) ) ) . '">$1 checkout test item</a>.</p>' );
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $home );
update_option( 'blogname', 'ZARA — Unofficial Concept Store' );
update_option( 'blogdescription', 'The everyday edit. An independent fashion concept powered by Tendr.' );
update_option( 'blog_public', '0' );
update_option( 'woocommerce_default_catalog_orderby', 'menu_order' );
switch_theme( 'tendr-fashion' );
flush_rewrite_rules();
WP_CLI::success( 'Fashion concept installed: six products, thirty size variations, homepage and concept page. Existing orders and payment configuration retained.' );
