/**
 * media-href.js —— 产物地址的判定口径：后端 media 项、最终回答里的链接、面板里的图
 * 都落在这几类地址上。判定只这一份：一处点开是弹出窗口、另一处整扇窗口翻到 /view 图片页
 * 就是判定分叉出来的。
 */

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mkv|avi|mp3|wav|ogg|m4a|aac|flac)(?=&|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)(?=&|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(?=&|#|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|tiff?)(?=&|#|$)/i;
const MEDIA_PATH = /^\/(view|neo_gallery\/\w*|rs_recipes\/(asset|thumbnail))(?=\?|#|$)/;

export const isMediaHref = (href) => MEDIA_PATH.test(href) || MEDIA_EXT.test(href);
/** 这一条素材是哪一类：strict 只认扩展名，认不出给 null。画布收本地文件那一发要的正是判得出「不收」，
 *  把 .zip 当成图片落一张节点，卡上就是一张永远读不出来的占位图。默认不 strict 是既有调用方的口径
 *  （产物链接里认不出扩展名的照样当图片处理），加了参数默认值不变 */
export const mediaKindOf = (href, strict = false) => (VIDEO_EXT.test(href) ? "video"
    : AUDIO_EXT.test(href) ? "audio"
    : IMAGE_EXT.test(href) ? "image" : strict ? null : "image");
