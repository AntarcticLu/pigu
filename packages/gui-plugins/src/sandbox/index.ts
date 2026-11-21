import { Plugin } from "@opencode/plugin/gui"
import en from "./i18n/en"
import zh from "./i18n/zh"
import zht from "./i18n/zht"

export default Plugin.define({
  i18n: {
    en,
    zh,
    zht,
  },
})
