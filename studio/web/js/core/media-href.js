/**
 * media-href.js —— 产物地址的判定口径：后端 media 项、最终回答里的链接、右栏与中间放映区的图
 * 都落在这几类地址上。右栏（agent-panel.js）与放映区（agent-stage.js）共用这一份：
 * 判定分叉就等于一处点开是弹出窗口、另一处整扇窗口翻到 /view 图片页。
 */

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mkv|avi|mp3|wav|ogg|m4a|aac|flac)(?=&|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)(?=&|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(?=&|#|$)/i;
const MEDIA_PATH = /^\/(view|neo_gallery\/\w*|rs_recipes\/(asset|thumbnail))(?=\?|#|$)/;

export const isMediaHref = (href) => MEDIA_PATH.test(href) || MEDIA_EXT.test(href);
export const mediaKindOf = (href) => (VIDEO_EXT.test(href) ? "video" : AUDIO_EXT.test(href) ? "audio" : "image");
