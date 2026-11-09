// Whether a person keeps the chat across the whole page, with what is behind it out of the way.
// Theirs alone, and remembered in this browser from one chat to the next.

import { useCallback, useState } from "react";

const KEY = "texera.chat.maximized";

const read = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

export function useChatMaximized(): [boolean, () => void] {
  const [maximized, setMaximized] = useState(read);
  const toggle = useCallback(() => {
    setMaximized(was => {
      try {
        localStorage.setItem(KEY, was ? "0" : "1");
      } catch {
        // A browser that keeps nothing keeps this for the page.
      }
      return !was;
    });
  }, []);
  return [maximized, toggle];
}
