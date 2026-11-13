function unsupportedModule(moduleName, detail) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        return () => {
          throw new Error(
            `[${moduleName}] 当前反重力小说翻译插件未实装二进制重依赖模块 (${String(prop)}): ${detail}`,
          );
        };
      },
    },
  );
}

export const pdfStub = unsupportedModule("@lg/pdf", "C++ MuPDF 排版重绘引擎未在小说插件中启用");
export const mediaStub = unsupportedModule("@lg/media", "本地 ONNX/WebGPU 音视频识别引擎未在小说插件中启用");
export const uvStub = unsupportedModule("@lg/uv", "内置 uv Python 环境未在小说插件中启用");
export const npmStub = unsupportedModule("@lg/npm", "内置共享 npm 安装器未在小说插件中启用（常用 jszip/chardet/iconv-lite 已内置）");
export const searchStub = unsupportedModule("@lg/search", "请直接使用反重力宿主内置的 search_web 工具完成网页检索");
