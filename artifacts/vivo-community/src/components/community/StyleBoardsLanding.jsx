import { useState } from "react";
import { styleBoards } from "./mockData";
import { ImagePlaceholder, cardCls } from "./ui";

export default function StyleBoardsLanding({ onGuest }) {
  const [followed, setFollowed] = useState({});

  const toggleFollow = (index) => {
    if (onGuest) {
      onGuest();
      return;
    }
    setFollowed((current) => ({ ...current, [index]: !current[index] }));
  };

  return (
    <section data-testid="style-boards-landing">
      <header className="mb-7 sm:mb-9 max-w-2xl">
        <h2 className="font-serif text-3xl sm:text-4xl text-foreground tracking-tight">Style Boards</h2>
        <p className="mt-3 text-sm sm:text-[15px] leading-relaxed text-muted-foreground">
          Curated looks and outfit inspiration from the Vivo team — mix, match, and make them your own.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {styleBoards.map((board, index) => (
          <article key={board.title} className={`${cardCls} overflow-hidden group`}>
            <div className="grid grid-cols-2 grid-rows-2 h-48 gap-px bg-border p-px">
              <ImagePlaceholder className="rounded-none h-full w-full border-none" aspectRatio="aspect-auto" text="" />
              <ImagePlaceholder className="rounded-none h-full w-full border-none" aspectRatio="aspect-auto" text="" />
              <ImagePlaceholder className="rounded-none h-full w-full col-span-2 border-none" aspectRatio="aspect-auto" text="" />
            </div>
            <div className="p-5 flex justify-between items-start gap-4 bg-background">
              <div className="min-w-0">
                <h3 className="font-serif text-foreground text-lg mb-1">{board.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground mb-3">{board.description}</p>
                <div className="text-xs text-muted-foreground tracking-wide uppercase">
                  {board.items} items • {board.followers} followers
                </div>
              </div>
              <button
                type="button"
                data-testid="follow-btn"
                data-board-index={index}
                onClick={() => toggleFollow(index)}
                className={`text-xs font-medium px-5 min-h-[44px] shrink-0 inline-flex items-center rounded transition-all active:scale-[0.95] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                  followed[index]
                    ? "bg-primary border-primary text-primary-foreground"
                    : "bg-background border-border text-foreground hover:bg-secondary"
                }`}
              >
                {followed[index] ? "Following" : "Follow"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}