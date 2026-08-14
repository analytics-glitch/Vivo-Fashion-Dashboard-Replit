import React, { useState } from "react";
import { ArrowLeft, ShoppingBag, Trash2, Sparkles } from "lucide-react";
import { useCart } from "@/context/CartContext";
import { QtyStepper, ImagePlaceholder, btnPrimary, btnSecondary, cardCls, kes } from "./ui";

function CartLine({ item, onQty, onRemove }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div data-testid={`cart-line-${item.key}`} className="flex gap-4 py-6">
      <div className="w-20 shrink-0">
        {item.image && !imgFailed ? (
          <img
            src={item.image}
            alt={item.name}
            onError={() => setImgFailed(true)}
            className="w-20 aspect-[3/4] object-contain rounded-sm bg-secondary"
          />
        ) : (
          <ImagePlaceholder aspectRatio="aspect-[3/4]" text="" className="w-20" />
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-serif text-[15px] text-foreground leading-snug line-clamp-2">{item.name}</div>
            <div className="text-[12px] text-muted-foreground mt-1">
              {item.color ? `${item.color} · ` : ""}Size {item.size}
            </div>
            <div className="text-[13px] text-foreground/80 mt-1">{kes(item.price)} each</div>
          </div>
          <button
            data-testid={`cart-remove-${item.key}`}
            aria-label={`Remove ${item.name} size ${item.size}`}
            onClick={onRemove}
            className="w-11 h-11 -mt-2 -mr-2 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Trash2 size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex items-end justify-between mt-auto pt-3">
          <QtyStepper
            compact
            idPrefix={`qty-${item.key}`}
            value={item.qty}
            min={1}
            max={item.maxStock || 99}
            onChange={onQty}
          />
          <div className="font-medium text-foreground">{kes(item.qty * item.price)}</div>
        </div>
      </div>
    </div>
  );
}

export default function CartView({ onBack, onShop }) {
  const { items, count, subtotal, updateQty, remove } = useCart();
  const [step, setStep] = useState("bag");

  if (step === "checkout") {
    return (
      <div data-testid="checkout-placeholder" className="max-w-md mx-auto text-center py-14 animate-in fade-in duration-500">
        <div className="w-16 h-16 mx-auto mb-7 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink">
          <Sparkles size={24} strokeWidth={1.5} />
        </div>
        <h2 className="font-serif text-3xl text-foreground mb-3">Almost there</h2>
        <p className="text-muted-foreground text-[15px] leading-relaxed mb-8">
          In-app checkout is arriving soon. Your bag is saved on this device —
          and our stylists can complete your order in any Vivo store today.
        </p>
        <div className={`${cardCls} p-5 text-left mb-8`}>
          <div className="flex justify-between text-[14px] py-1.5">
            <span className="text-muted-foreground">Items</span>
            <span className="text-foreground font-medium">{count}</span>
          </div>
          <div className="flex justify-between text-[14px] py-1.5">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="text-foreground font-medium">{kes(subtotal)}</span>
          </div>
          <div className="flex justify-between text-[14px] py-1.5 border-t border-border mt-2 pt-3">
            <span className="text-muted-foreground">Delivery</span>
            <span className="text-foreground/70">Calculated at checkout</span>
          </div>
        </div>
        <div className="space-y-3">
          <button data-testid="checkout-continue" onClick={onShop} className={btnPrimary}>
            Continue Browsing
          </button>
          <button data-testid="checkout-back" onClick={() => setStep("bag")} className={btnSecondary}>
            Back to your bag
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="cart-view" className="animate-in fade-in duration-500 max-w-5xl mx-auto">
      <button
        data-testid="cart-back"
        onClick={onBack}
        className="flex items-center gap-2 min-h-[44px] mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <ArrowLeft size={15} /> Continue shopping
      </button>
      <h2 className="font-serif text-3xl text-foreground mb-8">
        Your Bag{count > 0 ? ` (${count})` : ""}
      </h2>

      {items.length === 0 ? (
        <div data-testid="cart-empty" className="text-center py-16 max-w-sm mx-auto">
          <ShoppingBag size={32} strokeWidth={1.2} className="mx-auto mb-5 text-muted-foreground/40" />
          <h3 className="font-serif text-xl text-foreground mb-2">Your bag is empty</h3>
          <p className="text-muted-foreground text-[14px] leading-relaxed mb-8">
            The Shop is full of pieces made for you — anything you add waits here,
            sized, saved and ready when you are.
          </p>
          <button onClick={onShop} className={btnPrimary}>Explore the Collection</button>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_340px] gap-10 items-start">
          <div className="divide-y divide-border border-y border-border">
            {items.map((it) => (
              <CartLine
                key={it.key}
                item={it}
                onQty={(q) => updateQty(it.key, q)}
                onRemove={() => remove(it.key)}
              />
            ))}
          </div>

          <aside className={`${cardCls} p-6 lg:sticky lg:top-24`}>
            <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-5">Summary</h3>
            <div className="flex justify-between text-[14px] py-2">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="text-foreground font-medium">{kes(subtotal)}</span>
            </div>
            <div className="flex justify-between text-[14px] py-2">
              <span className="text-muted-foreground">Delivery</span>
              <span className="text-foreground/70">Calculated at checkout</span>
            </div>
            <div className="flex justify-between items-baseline py-3 mt-2 border-t border-border">
              <span className="text-[14px] font-semibold text-foreground">Total</span>
              <span data-testid="cart-subtotal" className="text-lg font-medium text-foreground">{kes(subtotal)}</span>
            </div>
            <button data-testid="cart-checkout-btn" onClick={() => setStep("checkout")} className={`${btnPrimary} mt-4`}>
              Proceed to Checkout
            </button>
            <p className="text-[12px] text-muted-foreground leading-relaxed mt-4 text-center">
              Free returns within 14 days · Points on every order
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
