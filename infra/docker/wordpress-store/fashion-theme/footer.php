<?php defined( 'ABSPATH' ) || exit; ?>
    </div></div>
    <footer class="fashion-footer">
        <div class="fashion-footer-top">
            <div><div class="fashion-footer-brand">ZARA</div><p>A study in everyday dressing.<br>An independent fashion concept, brought to life with Tendr.</p></div>
            <div><h2>Explore</h2><ul>
                <li><a href="<?php echo esc_url( wc_get_page_permalink( 'shop' ) ); ?>">The collection</a></li>
                <li><a href="<?php echo esc_url( tendr_fashion_category( 'woman' ) ); ?>">Woman</a></li>
                <li><a href="<?php echo esc_url( tendr_fashion_category( 'man' ) ); ?>">Man</a></li>
                <li><a href="<?php echo esc_url( tendr_fashion_category( 'essentials' ) ); ?>">Everyday essentials</a></li>
                <li><a href="<?php echo esc_url( tendr_fashion_category( 'accessories' ) ); ?>">Accessories</a></li>
                <li><a href="<?php echo esc_url( tendr_fashion_category( 'fragrance' ) ); ?>">Fragrance</a></li>
            </ul></div>
            <div><h2>The store</h2><ul>
                <li><a href="<?php echo esc_url( home_url( '/the-concept/' ) ); ?>">About this concept</a></li>
                <li><a href="<?php echo esc_url( wc_get_cart_url() ); ?>">Your shopping bag</a></li>
                <li><a href="<?php echo esc_url( wc_get_page_permalink( 'myaccount' ) ); ?>">Your account</a></li>
                <li><a href="<?php echo esc_url( home_url( '/product/tendr-checkout-test/' ) ); ?>">$1 checkout test</a></li>
            </ul></div>
        </div>
        <div class="fashion-footer-bottom"><span>Unofficial demo. Not affiliated with Zara or Inditex. Concept products and images; no fulfillment.</span><span>Checkout powered by <strong>tendr</strong></span></div>
    </footer>
</div>
<?php wp_footer(); ?>
</body></html>
