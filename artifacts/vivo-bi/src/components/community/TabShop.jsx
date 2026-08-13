import React, { useState } from 'react';
import { products, posts } from "./mockData";
import { ImagePlaceholder } from "./ui";
import { ShoppingCart, Heart } from "@phosphor-icons/react";

function ShoppableLook({ post }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      data-testid={`shop-look-${post.id}`}
      onClick={() => setRevealed(r => !r)}
      className="relative group rounded-2xl overflow-hidden aspect-[4/3] bg-black cursor-pointer"
    >
      <ImagePlaceholder aspectRatio="h-full w-full opacity-70 group-hover:opacity-50 transition-opacity" className="rounded-none" />
      <div
        className={`absolute top-4 right-4 bg-white/95 backdrop-blur text-[#2c2a29] text-xs font-bold px-3 py-1.5 rounded-full shadow-lg transition-opacity duration-300 ${
          revealed ? "opacity-0" : "opacity-100 group-hover:opacity-0"
        }`}
      >
        Shop this look →
      </div>
      <div className="absolute inset-0 flex flex-col justify-end p-6">
        <div
          className={`transform transition-all duration-300 ${
            revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
          } group-hover:translate-y-0 group-hover:opacity-100`}
        >
          <div className="text-white font-medium mb-4 drop-shadow-md line-clamp-2">"{post.caption}"</div>
          <div className="flex gap-3 overflow-x-auto hide-scrollbar">
            {post.taggedProducts?.map(prod => (
              <div key={prod.id} className="bg-white/95 backdrop-blur rounded-xl p-2 flex items-center gap-3 min-w-[200px] shadow-lg">
                <div className="w-10 h-10 bg-[#ebdcd0] rounded flex items-center justify-center text-xs">📸</div>
                <div className="flex-grow">
                  <div className="text-xs font-bold text-[#2c2a29] truncate max-w-[120px]">{prod.name}</div>
                  <div className="text-xs text-[#c25e30] font-bold">KES {prod.price.toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductCard({ product }) {
  const [wishlist, setWishlist] = useState(product.liked);
  const [inCart, setInCart] = useState(false);

  return (
    <div className="group flex flex-col bg-white rounded-2xl overflow-hidden shadow-[0_2px_10px_rgba(44,42,41,0.04)] hover:-translate-y-1 transition-all duration-300">
      <div className="relative">
        <ImagePlaceholder aspectRatio="aspect-[3/4]" className="rounded-none" />
        <button 
          data-testid="wishlist-btn"
          onClick={() => setWishlist(!wishlist)}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/80 backdrop-blur flex items-center justify-center text-[#c25e30] shadow-sm hover:bg-white transition-colors"
        >
          {wishlist ? <span>❤</span> : <Heart weight="bold" size={18} />}
        </button>
      </div>
      <div className="p-4 sm:p-5 flex flex-col flex-grow">
        <div className="text-xs font-bold uppercase tracking-widest text-[#a8a199] mb-1">{product.brand}</div>
        <h3 className="font-bold text-[#2c2a29] text-sm sm:text-base leading-snug mb-2 flex-grow">{product.name}</h3>
        <div className="font-extrabold text-[#c25e30] mb-4">KES {product.price.toLocaleString()}</div>
        
        <button 
          data-testid="add-to-cart-btn"
          onClick={() => setInCart(true)}
          disabled={inCart}
          className={`w-full py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all ${
            inCart 
              ? "bg-[#e8dfd5] text-[#7a746e]" 
              : "bg-[#2c2a29] text-white hover:bg-[#1a1918]"
          }`}
        >
          {inCart ? "Added to Cart" : <><ShoppingCart weight="bold" size={16} /> Add to Cart</>}
        </button>
      </div>
    </div>
  );
}

export default function TabShop() {
  const [filter, setFilter] = useState("All");
  const brands = ["All", "Vivo", "Safari", "Zoya"];
  
  const filteredProducts = filter === "All" ? products : products.filter(p => p.brand === filter);

  return (
    <div className="animate-in fade-in duration-500">
      {/* Filters */}
      <div className="flex gap-2 mb-8 overflow-x-auto hide-scrollbar pb-2">
        {brands.map(b => (
          <button
            key={b}
            onClick={() => setFilter(b)}
            className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${
              filter === b 
                ? "bg-[#2c2a29] text-white shadow-md" 
                : "bg-white text-[#7a746e] hover:bg-[#f5ece4] border border-[#f0e9e1]"
            }`}
          >
            {b}
          </button>
        ))}
      </div>
      
      {/* Product Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6 lg:gap-8 mb-16">
        {filteredProducts.map(p => (
          <ProductCard key={p.id} product={p} />
        ))}
        {filteredProducts.length === 0 && (
          <div className="col-span-full py-12 text-center text-[#7a746e]">
            No products found for this brand.
          </div>
        )}
      </div>
      
      {/* Shoppable UGC */}
      <div>
        <h2 className="text-2xl font-bold text-[#2c2a29] mb-6">Shoppable Looks from the Community</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {posts.slice(0, 2).map(post => (
            <ShoppableLook key={post.id} post={post} />
          ))}
        </div>
      </div>
    </div>
  );
}
