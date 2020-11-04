import { compile, callbacksMap } from "./define.js";
import { stringifyElement } from "./utils.js";

const placeholder = Date.now();
const connect = `__router__connect__${placeholder}__`;

const configs = new WeakMap();
const disconnects = new WeakMap();

const ids = new Map();
const urls = new Map();

function setupWrapper(View) {
  const Wrapper = { prototype: {} };
  const hybrids = { ...View, render: { get: View.render } };
  delete hybrids[connect];

  compile(Wrapper, hybrids);

  return Wrapper;
}

function setupOptions(options) {
  if (typeof options === "string") options = { url: options };
  return options;
}

function getUrl(View, params = {}) {
  const config = configs.get(View);

  if (!config) {
    throw Error("Provided view must be connected to the router view list");
  }

  return config.url(params);
}

function getBackUrl(View, params = {}) {
  const stateList = window.history.state;

  if (stateList.length > 1) {
    return stateList[stateList.length - 2].url;
  }

  return getUrl(View, params);
}

function getFullUrl(url) {
  return url.pathname + url.search;
}

function getStateFromURL(url, fallback) {
  const fullUrl = getFullUrl(url);
  let desc = urls.get(fullUrl);

  if (!desc) {
    // TODO: Find config by ids which can have placeholders
    let config = ids.get(url.pathname);
    let descUrl = fullUrl;

    const params = {};

    if (!config) {
      config = fallback;
      descUrl = fallback.url();
    }

    desc = {
      id: config.id,
      order: config.order,
      params,
      url: descUrl,
    };

    urls.set(descUrl, desc);
  }

  return desc;
}

const defaultTitle = document.title;
function setupView(View, order) {
  let config = configs.get(View);
  if (!config) {
    const options = setupOptions(View[connect]);
    const Wrapper = setupWrapper(View);
    const callbacks = callbacksMap.get(Wrapper);
    const proto = {};

    Object.keys(Wrapper.prototype).forEach(key => {
      Object.defineProperty(
        proto,
        key,
        Object.getOwnPropertyDescriptor(Wrapper.prototype, key),
      );
    });

    let [id, searchKeys = ""] = options.url.split("?");
    searchKeys = searchKeys.split(",");

    const paramsKeys = [];
    id = id.replace(/:([^/]+)/g, (_, key) => {
      paramsKeys.push(key);
      return placeholder;
    });

    config = {
      id,
      title: options.title || defaultTitle,
      order,
      View,
      connect(instance = Object.create(proto)) {
        const list = callbacks.map(cb => cb(instance)).filter(cb => cb);

        disconnects.set(instance, list);
        configs.set(instance, config);

        return instance;
      },
      url(params) {
        let url = id;

        if (paramsKeys.length) {
          url = url.split(placeholder).reduce((acc, part, index) => {
            if (index === 0) return part;
            const key = paramsKeys[index - 1];

            if (!hasOwnProperty.call(params, key)) {
              throw Error(`The '${key}' parameter must be defined`);
            }

            return `${acc}${params[key]}${part}`;
          });
        }

        if (searchKeys.length) {
          const searchParams = searchKeys.reduce((acc, key) => {
            if (hasOwnProperty.call(params, key)) {
              acc.push(`${key}=${params[key]}`);
            }
            return acc;
          }, []);
          if (searchParams.length) {
            url += `?${searchParams.join("&")}`;
          }
        }

        urls.set(url, { id, params, url, order });

        return url;
      },
    };

    ids.set(config.id, config);
    configs.set(View, config);
  }

  return config;
}

function registerViews(views, order = 0) {
  let result;

  views.forEach((view, index) => {
    const config = Array.isArray(view)
      ? registerViews(view, order + index)
      : setupView(view, order + index);
    if (index === 0) result = config;
  });

  return result;
}

function disconnectInstance(instance) {
  disconnects.get(instance).forEach(cb => cb());
  disconnects.delete(instance);
}

function navigate(url, cb) {
  const nextState = getStateFromURL(url);
  const stateList = window.history.state;
  const nextIndex = stateList.findIndex(data => data.id === nextState.id);

  if (nextIndex > -1) {
    const offset = -(stateList.length - nextIndex - 1);
    if (offset) window.history.go(offset);
    // TODO: params might have changed...
  } else {
    const currentState = stateList[stateList.length - 1];

    if (nextState.id === currentState.id) {
      window.history.replaceState(
        [...stateList].splice(stateList.length - 1, 1, nextState),
        "",
      );
      cb();
    } else if (nextState.order >= currentState.order) {
      window.history.pushState(
        [].concat(stateList, nextState),
        "",
        nextState.url,
      );
      cb();
    } else {
      const offset = stateList.length - 1;
      const replace = popStateEvent => {
        if (popStateEvent) {
          window.removeEventListener("popstate", replace);
        }

        window.history.replaceState([nextState], "", nextState.url);
        cb();
      };

      if (offset > 0) {
        window.addEventListener("popstate", replace);
        window.history.go(-offset);
      } else {
        replace();
      }
    }
  }
}

const resolvers = new WeakMap();
function resolve(event, promise) {
  resolvers.set(event, promise);
}

let activePromise;
function resolveEvent(event, url, cb) {
  const promise = resolvers.get(event) || Promise.resolve();
  event.preventDefault();

  activePromise = promise;

  promise.then(() => {
    if (promise === activePromise) navigate(url, cb);
    activePromise = null;
  });
}

function handleAnchorClick(event, cb) {
  if (!event.defaultPrevented && !event.ctrlKey && !event.metaKey) {
    const anchorEl = event
      .composedPath()
      .find(el => el instanceof HTMLAnchorElement);

    if (
      anchorEl &&
      anchorEl.origin === window.location.origin &&
      urls.has(getFullUrl(anchorEl))
    ) {
      resolveEvent(event, anchorEl, cb);
    }
  }
}

function handleFormSubmit(event, cb) {
  if (!event.defaultPrevented) {
    const action = event.submitter.hasAttribute("formaction")
      ? event.submitter.formAction
      : event.target.action;

    const url = new URL(action, window.location.origin);

    if (
      url.origin === window.location.origin &&
      (urls.has(getFullUrl(url)) || url.href === window.location.href)
    ) {
      resolveEvent(event, url, cb);
    }
  }
}

const stacks = new WeakMap();
const routers = new Set();

function router(views) {
  return {
    get(host) {
      const stack = stacks.get(host);
      const instance = stack[stack.length - 1];
      const config = configs.get(instance);
      const update = instance.render;

      document.title =
        typeof config.title === "function"
          ? config.title(instance)
          : config.title;

      return () => {
        update(instance, host);
      };
    },
    connect(host, key, invalidate) {
      if (routers.has(host)) {
        throw Error(
          `Duplicated router in '${key}' property of the ${stringifyElement(
            host,
          )}. The definition already contains a router factory.`,
        );
      } else if (routers.size && host instanceof HTMLElement) {
        throw Error(
          `You must have only one ${stringifyElement(
            host,
          )} element connected to the DOM.`,
        );
      }

      function updateStack() {
        const lastStack = stacks.get(host) || [];
        const { state } = window.history;

        stacks.set(
          host,
          state.map(({ id, params }, index) => {
            const config = ids.get(id);
            const prevInstance = lastStack[index];
            let instance;

            if (prevInstance) {
              if (config !== configs.get(prevInstance)) {
                if (disconnects.get(prevInstance)) {
                  disconnectInstance(prevInstance);
                }
                // TODO: reassign values for HMR update
              } else {
                instance = disconnects.get(prevInstance)
                  ? prevInstance
                  : config.connect(prevInstance);
              }
            }

            instance = instance || config.connect();

            if (index === state.length - 1) {
              Object.assign(instance, params);
            }

            return instance;
          }),
        );

        for (let i = state.length; i < lastStack.length; i += 1) {
          disconnectInstance(lastStack[i]);
        }

        invalidate();
      }

      function onClick(event) {
        handleAnchorClick(event, updateStack);
      }

      function onSubmit(event) {
        handleFormSubmit(event, updateStack);
      }

      const defaultConfig = registerViews(views);
      routers.add(host);

      if (!window.history.state) {
        const nextState = getStateFromURL(window.location, defaultConfig);
        window.history.replaceState([nextState], "", nextState.url);
      }

      updateStack();

      window.addEventListener("popstate", updateStack);
      host.addEventListener("click", onClick);
      host.addEventListener("submit", onSubmit);

      return () => {
        window.removeEventListener("popstate", updateStack);
        host.removeEventListener("click", onClick);
        host.removeEventListener("submit", onSubmit);

        stacks.get(host).forEach(disconnectInstance);
        routers.delete(host);
      };
    },
    observe(host, flush) {
      flush();
    },
  };
}

export default Object.assign(router, {
  connect,
  url: getUrl,
  backUrl: getBackUrl,
  resolve,
});
