import { useEffect, useState } from "react";

// App.cssのモバイル用メディアクエリと同じブレークポイントを使うこと。
// CSSは「レイアウトの並べ替え」、このフックは「モバイル時のみdetails折りたたみに
// 切り替える」というDOM構造の分岐に使う。
export const MOBILE_MEDIA_QUERY = "(max-width: 768px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(MOBILE_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}
