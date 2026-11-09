<?php
/** Storefront presentation only; WooCommerce and Tendr own checkout and order processing. */
defined( 'ABSPATH' ) || exit;

add_action( 'wp_enqueue_scripts', function () {
    wp_enqueue_style( 'tendr-fashion', get_stylesheet_uri(), array( 'storefront-style' ), filemtime( get_stylesheet_directory() . '/style.css' ) );
}, 30 );

add_action( 'init', function () {
    remove_action( 'storefront_sidebar', 'storefront_get_sidebar', 10 );
    remove_action( 'storefront_footer', 'storefront_credit', 20 );
    remove_action( 'storefront_after_footer', 'storefront_handheld_footer_bar', 999 );
} );
add_filter( 'storefront_customizer_google_font_families', '__return_empty_array' );
add_filter( 'loop_shop_columns', function () { return 3; } );
add_filter( 'loop_shop_per_page', function () { return 12; } );
add_filter( 'woocommerce_output_related_products_args', function ( $args ) {
    $args['posts_per_page'] = 3;
    $args['columns'] = 3;
    return $args;
} );

function tendr_fashion_asset( $name ) {
    return get_stylesheet_directory_uri() . '/assets/' . $name . '.webp';
}
function tendr_fashion_category( $slug ) {
    $term = get_term_by( 'slug', $slug, 'product_cat' );
    return $term ? get_term_link( $term ) : wc_get_page_permalink( 'shop' );
}
function tendr_fashion_navigation() {
    $links = array(
        'The new collection' => wc_get_page_permalink( 'shop' ),
        'Woman' => tendr_fashion_category( 'woman' ),
        'Man' => tendr_fashion_category( 'man' ),
        'Essentials' => tendr_fashion_category( 'essentials' ),
        'The concept' => home_url( '/the-concept/' ),
    );
    foreach ( $links as $label => $href ) {
        echo '<a href="' . esc_url( $href ) . '">' . esc_html( $label ) . '</a>';
    }
}
function tendr_fashion_search( $id ) {
    ?>
    <form class="fashion-search" role="search" method="get" action="<?php echo esc_url( home_url( '/' ) ); ?>">
        <label class="screen-reader-text" for="<?php echo esc_attr( $id ); ?>">Search clothing</label>
        <input id="<?php echo esc_attr( $id ); ?>" type="search" name="s" placeholder="Search the collection" value="<?php echo esc_attr( get_search_query() ); ?>">
        <input type="hidden" name="post_type" value="product">
        <button aria-label="Search" type="submit"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button>
    </form>
    <?php
}
function tendr_fashion_card( $product ) {
    $color = $product->get_meta( '_tendr_fashion_color' );
    $swatch = sanitize_hex_color( $product->get_meta( '_tendr_fashion_swatch' ) ) ?: '#ddd';
    ?>
    <article class="fashion-product">
        <a class="fashion-product-image" href="<?php echo esc_url( $product->get_permalink() ); ?>" aria-label="<?php echo esc_attr( $product->get_name() ); ?>">
            <?php echo $product->get_image( 'woocommerce_single', array( 'loading' => 'lazy' ) ); ?>
            <span>The everyday edit</span>
        </a>
        <div class="fashion-product-details">
            <h3><a href="<?php echo esc_url( $product->get_permalink() ); ?>"><?php echo esc_html( $product->get_name() ); ?></a></h3>
            <div class="fashion-product-price"><?php echo wp_kses_post( $product->get_price_html() ); ?></div>
        </div>
        <p class="fashion-product-color"><i style="--swatch:<?php echo esc_attr( $swatch ); ?>" aria-hidden="true"></i><?php echo esc_html( $color ); ?></p>
    </article>
    <?php
}
function tendr_fashion_demo_note() {
    echo '<p class="fashion-demo-note">Concept-store demo item. No physical goods are shipped. Checkout uses the store’s configured Tendr payment mode.</p>';
}
add_action( 'woocommerce_single_product_summary', 'tendr_fashion_demo_note', 25 );
add_action( 'woocommerce_before_cart', 'tendr_fashion_demo_note', 5 );
add_action( 'woocommerce_before_checkout_form', 'tendr_fashion_demo_note', 5 );

// Cart and Checkout Blocks do not run the classic checkout hooks.
add_filter( 'the_content', function ( $content ) {
    if ( is_main_query() && in_the_loop() && ( is_cart() || is_checkout() ) && has_blocks( $content ) ) {
        return '<p class="fashion-demo-note">You are checking out in an unofficial fashion demo. These are demonstration items; nothing will be shipped. If Tendr is in Live mode, completing payment moves real funds.</p>' . $content;
    }
    return $content;
}, 8 );
