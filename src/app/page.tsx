"use client";

import dynamic from "next/dynamic";

const DarijaApp = dynamic(() => import("@/darija/App"), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-screen place-items-center bg-[#090a0c] text-zinc-400">
      كنحمّلو الأستاذ Vox…
    </div>
  ),
});

export default function Home() {
  return <DarijaApp />;
}
