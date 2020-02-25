'use strict';
// rfc7231 6.1

// 默认情况下下列状态码缓存才生效？没有 304？
// 相应状态码的含义：https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status
const statusCodeCacheableByDefault = [
    // 不同请求方法对成功有不同的定义
    200,
    // 203 是由代理服务器告知给客户端的，表示内容已被代理服务器修改
    // 比如浏览器被 whistle（http://127.0.0.1:8899 就是代理服务器地址） 给代理了，
    // 然后 whistle 对服务器的返回的内容进行了修改（可以通过 whistle.script 修改），
    // 原本服务器是返回 200 的，但是 whistle 应该给浏览器返回 203
    203,
    // 返回更新的头部而不需要返回内容
    204,
    // 主要用于断点续传
    // 【Todo】断点续传的实现和相关学习
    206,
    300,
    301,
    404,
    405,
    410,
    414,
    501,
];

// This implementation does not understand partial responses (206)
// 此程序能够识别的状态码
const understoodStatuses = [
    200,
    203,
    204,
    300,
    301,
    // ====== 下列是比 statusCodeCacheableByDefault 多出的部分
    302,
    303,
    307,
    308,
    // 上面是比 statusCodeCacheableByDefault 多出的部分 ======
    404,
    405,
    410,
    414,
    501,
];

// HTTP Header（HTTP 消息头）的文档可看这里：https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers
// Hop-by-hop headers 翻译过来是逐跳消息头，也在上述文档中有说明
// 直白点说就是如果浏览器和服务器之间有个 whistle，
// 那么浏览器收到的这些头部应该认为这些消息头是 whistle 设置的，而不是服务器
const hopByHopHeaders = {
    date: true, // included, because we add Age update Date
    connection: true,
    'keep-alive': true,
    'proxy-authenticate': true,
    'proxy-authorization': true,
    te: true,
    trailer: true,
    'transfer-encoding': true,
    upgrade: true,
};
// 【Todo】排除以下的验证更新是什么鬼？
const excludedFromRevalidationUpdate = {
    // Since the old body is reused, it doesn't make sense to change properties of the body
    'content-length': true,
    'content-encoding': true,
    'transfer-encoding': true,
    'content-range': true,
};
// 解析 CacheControl 头部的值，传入字符串，返回 CacheControl 对象，例如传入 'no-cache, max-age=1234'，返回 { 'no-cache': true, 'max-age': '1234' }
function parseCacheControl(header) {
    const cc = {};
    if (!header) return cc;

    // TODO: When there is more than one value present for a given directive (e.g., two Expires header fields, multiple Cache-Control: max-age directives),
    // the directive's value is considered invalid. Caches are encouraged to consider responses that have invalid freshness information to be stale
    const parts = header.trim().split(/\s*,\s*/); // TODO: lame parsing，多个 Cache-Control 的值用 “,” 隔开，“,” 两端可以有无限个空白符，这里和 Set-Cookies 用 “;” 隔开不一样哦
    for (const part of parts) {
        const [k, v] = part.split(/\s*=\s*/, 2); // 每个值可能是 key=value 的形式，也可能是 key 的形式，单纯 key 的形式，转换成对象的值就是 true
        cc[k] = v === undefined ? true : v.replace(/^"|"$/g, ''); // TODO: lame unquoting，value 可以带有 " 号，例如 max-age="1234"，转成对象的值的时候会去掉 " 号，例如 '"1234"' => '1234'
    }

    return cc;
}

function formatCacheControl(cc) {
    let parts = [];
    for (const k in cc) {
        const v = cc[k];
        parts.push(v === true ? k : k + '=' + v);
    }
    if (!parts.length) {
        return undefined;
    }
    return parts.join(', ');
}

// 1. 导出一个缓存策略的类
module.exports = class CachePolicy {
    // 当完成一次 HTTP 请求和响应之后，浏览器内部会用请求和响应构造一个 CachePolicy 的实例，
    // 该实例存储了请求的一些信息，包括 url path、host、请求头部等，还有响应的一些信息，包括响应到达时间、状态码、响应头部等
    // 最主要的是解析了请求和响应的 Cache-Control 头部，对于无 Cache-Control 有 Pragma: no-cache 头部的情况也做了兼容
    // 还记录了 Authorization 头部是否存在的情况
    constructor(
        req,
        res,
        {
            shared,
            cacheHeuristic,
            immutableMinTimeToLive,
            ignoreCargoCult,
            _fromObject,
        } = {}
    ) {
        if (_fromObject) {
            this._fromObject(_fromObject); // 【Todo】暂时不管是干嘛的，测试用例里面没传
            return;
        }

        if (!res || !res.headers) {
            throw Error('Response headers missing'); // 响应必须有 headers 对象，即便是空对象
        }
        this._assertRequestHasHeaders(req); // 请求也必须有 headers 对象，空对象也行

        this._responseTime = this.now(); // 响应接收到的时间设成当前时间
        this._isShared = shared !== false; // shared 为 false，_isShared 就是 false，除此之外，_isShared 都是 true
        this._cacheHeuristic =
            undefined !== cacheHeuristic ? cacheHeuristic : 0.1; // 10% matches IE，_cacheHeuristic 默认值是 0.1
        this._immutableMinTtl =
            undefined !== immutableMinTimeToLive
                ? immutableMinTimeToLive
                : 24 * 3600 * 1000; // _immutableMinTtl 默认值是 1 天

        this._status = 'status' in res ? res.status : 200; // 响应状态码默认是 200
        this._resHeaders = res.headers;
        this._rescc = parseCacheControl(res.headers['cache-control']); // {}
        this._method = 'method' in req ? req.method : 'GET'; // 请求方法默认是 'GET'
        this._url = req.url; // 请求 URL，如 '/'
        this._host = req.headers.host; // 请求的 host，默认 undefined
        this._noAuthorization = !req.headers.authorization; // 请求是否有 Authorization 头部，它的值是用户的凭据，例如 Basic: YWxhZGRpbjpvcGVuc2VzYW1l，详情请看 https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers/Authorization
        this._reqHeaders = res.headers.vary ? req.headers : null; // Don't keep all request headers if they won't be used，
        this._reqcc = parseCacheControl(req.headers['cache-control']); // 解析请求的 cache-control 头部

        // Assume that if someone uses legacy, non-standard uncecessary options they don't understand caching,
        // so there's no point stricly adhering to the blindly copy&pasted directives.
        if (
            ignoreCargoCult && // 【Todo】非标准的选项，暂时不看，即使用 Cache-Control: pre-check, post-check
            'pre-check' in this._rescc &&
            'post-check' in this._rescc
        ) {
            delete this._rescc['pre-check'];
            delete this._rescc['post-check'];
            delete this._rescc['no-cache'];
            delete this._rescc['no-store'];
            delete this._rescc['must-revalidate'];
            this._resHeaders = Object.assign({}, this._resHeaders, {
                'cache-control': formatCacheControl(this._rescc),
            });
            delete this._resHeaders.expires;
            delete this._resHeaders.pragma;
        }

        // When the Cache-Control header field is not present in a request, caches MUST consider the no-cache request pragma-directive
        // as having the same effect as if "Cache-Control: no-cache" were present (see Section 5.2.1).
        if (
            res.headers['cache-control'] == null &&
            /no-cache/.test(res.headers.pragma)
        ) {
            this._rescc['no-cache'] = true; // 兼容 HTTP 1.0 的客户端，如果没有 Cache-Control，但是有 Pragma: no-cache，那么也视为 Cache-Control: no-cache
        }
    }

    now() {
        return Date.now();
    }

    storable() {
        // The "no-store" request directive indicates that a cache MUST NOT store any part of either this request or any response to it.
        return !!(
            !this._reqcc['no-store'] && // 请求头部没有 Cache-Control: no-store
            // A cache MUST NOT store a response to any request, unless:
            // The request method is understood by the cache and defined as being cacheable, and
            ('GET' === this._method ||
                'HEAD' === this._method ||
                ('POST' === this._method && this._hasExplicitExpiration())) && // 请求方式是 GET、HEAD 或者 POST，其中 POST 必须得设置缓存有效时间
            // the response status code is understood by the cache, and
            understoodStatuses.indexOf(this._status) !== -1 && // 响应的状态码必须在 understoodStatuses 中
            // the "no-store" cache directive does not appear in request or response header fields, and
            !this._rescc['no-store'] && // 响应的头部没有 Cache-Control: no-store
            // the "private" response directive does not appear in the response, if the cache is shared, and
            (!this._isShared || !this._rescc.private) && // 如果 cache 共享，那么响应的 Cache-Control 中就不能有 private
            // the Authorization header field does not appear in the request, if the cache is shared,
            (!this._isShared ||
                this._noAuthorization ||
                this._allowsStoringAuthenticated()) && // 如果 cache 共享，那么请求不能有 Authorization 头部，如果有的话必须保证响应的 Cache-Control 中有 must-revalidate 或者 public 或者 s-maxage
            // the response either:
            // contains an Expires header field, or
            (this._resHeaders.expires ||
                // contains a max-age response directive, or
                // contains a s-maxage response directive and the cache is shared, or
                // contains a public response directive.
                this._rescc['max-age'] ||
                (this._isShared && this._rescc['s-maxage']) ||
                this._rescc.public ||
                // has a status code that is defined as cacheable by default
                statusCodeCacheableByDefault.indexOf(this._status) !== -1) // 响应头有 Expires 或 Cache-Control 中有 max-age 或 s-message（仅针对共享缓存）或 public 或状态码在 statusCodeCacheableByDefault 中
        );
    }

    // 获取缓存有效时间
    _hasExplicitExpiration() {
        // 4.2.1 Calculating Freshness Lifetime
        // 共享缓存形式优先取响应中 Cache-Control 的 s-message，没有的话就按私有缓存的形式继续获取
        // 私有缓存形式优先获取响应中 Cache-Control 的 max-age，没有的话获取 Expires 的头部，还没有的话就代表没有缓存有效时间设置
        return (
            (this._isShared && this._rescc['s-maxage']) ||
            this._rescc['max-age'] ||
            this._resHeaders.expires
        );
    }

    _assertRequestHasHeaders(req) {
        if (!req || !req.headers) {
            throw Error('Request headers missing');
        }
    }
    // 根据请求的信息判断是否需要从缓存中取内容
    satisfiesWithoutRevalidation(req) {
        this._assertRequestHasHeaders(req); // 请求必须有头部

        // When presented with a request, a cache MUST NOT reuse a stored response, unless:
        // the presented request does not contain the no-cache pragma (Section 5.4), nor the no-cache cache directive,
        // unless the stored response is successfully validated (Section 4.3), and
        const requestCC = parseCacheControl(req.headers['cache-control']); // 解析请求的 Cache-Control
        if (requestCC['no-cache'] || /no-cache/.test(req.headers.pragma)) {
            return false; // 含有 no-cache (Cache-Control 或 Pragma)，则返回 false
        }

        if (requestCC['max-age'] && this.age() > requestCC['max-age']) {
            return false; // 缓存的响应的实际年龄大于请求中设置的最大年龄限制，则也不从缓存中获取
        }

        if (
            requestCC['min-fresh'] &&
            this.timeToLive() < 1000 * requestCC['min-fresh'] // 缓存离过期的时间小于 min-fresh 就不被使用了
        ) {
            return false; // 当请求中设置了希望获取的缓存在多久之后依然有效时（离失效还有多久），符合这个条件的缓存才会被使用
        }

        // the stored response is either:
        // fresh, or allowed to be served stale
        // 对于过期的缓存，如果请求中存在 max-stale，且缓存中的响应并未设置此响应到期不可使用（must-revalidate），且 max-stale 设的是 true（即只有 key，没有 value）或者大于过期的时长
        if (this.stale()) {
            const allowsStale =
                requestCC['max-stale'] &&
                !this._rescc['must-revalidate'] &&
                (true === requestCC['max-stale'] ||
                    requestCC['max-stale'] > this.age() - this.maxAge());
            if (!allowsStale) {
                return false;
            }
        }

        return this._requestMatches(req, false);
    }

    _requestMatches(req, allowHeadMethod) {
        // The presented effective request URI and that of the stored response match, and
        return (
            (!this._url || this._url === req.url) && // 缓存中的请求没有 URL，或者 URL 等于请求的 URL
            this._host === req.headers.host && // 缓存中的请求如果有 host 头部，那么请求中也必须得有，且相等，如果前者没有，后者也不能有
            // the request method associated with the stored response allows it to be used for the presented request, and
            (!req.method ||
                this._method === req.method ||
                (allowHeadMethod && 'HEAD' === req.method)) && // 如果请求中有请求的方法，那么缓存中的响应的方法必须与其一致
            // selecting header fields nominated by the stored response (if any) match those presented, and
            this._varyMatches(req)
        );
    }

    _allowsStoringAuthenticated() {
        //  following Cache-Control response directives (Section 5.2.2) have such an effect: must-revalidate, public, and s-maxage.
        return (
            this._rescc['must-revalidate'] ||
            this._rescc.public ||
            this._rescc['s-maxage']
        );
    }

    _varyMatches(req) {
        if (!this._resHeaders.vary) {
            return true; // 如果缓存的响应的头部没有 Vary，说明可以取缓存
        }

        // A Vary header field-value of "*" always fails to match
        if (this._resHeaders.vary === '*') {
            return false; // 如果缓存的响应的头部的 Vary 设为 *，说明不可以取缓存
        }

        const fields = this._resHeaders.vary
            .trim()
            .toLowerCase()
            .split(/\s*,\s*/); // '  aBc,   abCd  ' => ['abc', 'abcd']
        // Vary 指定的头部必须和缓存中请求的头部相等
        for (const name of fields) {
            if (req.headers[name] !== this._reqHeaders[name]) return false; // 请求中的某个头部必须等于缓存中请求的头部，才能取缓存
        }
        return true;
    }

    _copyWithoutHopByHopHeaders(inHeaders) {
        const headers = {};
        for (const name in inHeaders) {
            if (hopByHopHeaders[name]) continue;
            headers[name] = inHeaders[name];
        }
        // 9.1.  Connection
        if (inHeaders.connection) {
            const tokens = inHeaders.connection.trim().split(/\s*,\s*/);
            for (const name of tokens) {
                delete headers[name];
            }
        }
        if (headers.warning) {
            const warnings = headers.warning.split(/,/).filter(warning => {
                return !/^\s*1[0-9][0-9]/.test(warning);
            });
            if (!warnings.length) {
                delete headers.warning;
            } else {
                headers.warning = warnings.join(',').trim();
            }
        }
        return headers;
    }

    responseHeaders() {
        const headers = this._copyWithoutHopByHopHeaders(this._resHeaders);
        const age = this.age();

        // A cache SHOULD generate 113 warning if it heuristically chose a freshness
        // lifetime greater than 24 hours and the response's age is greater than 24 hours.
        if (
            age > 3600 * 24 &&
            !this._hasExplicitExpiration() &&
            this.maxAge() > 3600 * 24
        ) {
            headers.warning =
                (headers.warning ? `${headers.warning}, ` : '') +
                '113 - "rfc7234 5.5.4"';
        }
        headers.age = `${Math.round(age)}`;
        headers.date = new Date(this.now()).toUTCString();
        return headers;
    }

    /**
     * Value of the Date response header or current time if Date was invalid
     * @return timestamp
     */
    date() {
        const serverDate = Date.parse(this._resHeaders.date);
        if (isFinite(serverDate)) {
            return serverDate; // 如果头部有 Date，就认为这个是缓存的资源的创建时间
        }
        return this._responseTime; // 否则就将客户端接收到该响应的时间设为创建时间（有误差）
    }

    /**
     * Value of the Age header, in seconds, updated for the current time.
     * May be fractional.
     * 返回缓存中的响应从创建开始到现在实际的秒数
     * 如果响应是从代理服务器上获取，那么实际秒数就等于代理服务器返回的 Age 头部（即该响应从创建到从代理服务器获取该响应的秒数）加上客户端获取此响应到现在过去的秒数
     * 如果响应是从资源服务器上获取，则不会有 Age 头部，就只是资源从接收到现在过去的秒数
     * @return Number
     */
    age() {
        let age = this._ageValue();

        const residentTime = (this.now() - this._responseTime) / 1000;
        return age + residentTime;
    }

    _ageValue() {
        const ageValue = parseInt(this._resHeaders.age);
        return isFinite(ageValue) ? ageValue : 0; // ageValue 是 Infinity 的话会被设置为 0
    }

    /**
     * Value of applicable max-age (or heuristic equivalent) in seconds. This counts since response's `Date`.
     *
     * For an up-to-date value, see `timeToLive()`.
     * 
     * 缓存中的响应从创建起能够最多在多久之内依然认为有效，会通过各种头部来确定
     *
     * @return Number
     */
    maxAge() {
        if (!this.storable() || this._rescc['no-cache']) {
            return 0; // 不可被缓存或者有 no-cache，则缓存不被允许有效，或者缓存都不存在
        }

        // Shared responses with cookies are cacheable according to the RFC, but IMHO it'd be unwise to do so by default
        // so this implementation requires explicit opt-in via public header
        if (
            this._isShared &&
            (this._resHeaders['set-cookie'] &&
                !this._rescc.public &&
                !this._rescc.immutable)
        ) {
            return 0; // 缓存中的内容属于共享缓存、缓存的响应的头部有设置 Cookie、Cache-Control 中没有 public 和 immutable，就认为缓存无效
        }

        if (this._resHeaders.vary === '*') {
            return 0; // 缓存的响应的头部有 vary，那也被视为无效
        }

        if (this._isShared) {
            if (this._rescc['proxy-revalidate']) {
                return 0; // 缓存中的内容属于共享缓存、缓存的响应 Cache-Control 中有 proxy-revalidate 也被视为无效
            }
            // if a response includes the s-maxage directive, a shared cache recipient MUST ignore the Expires field.
            if (this._rescc['s-maxage']) {
                return parseInt(this._rescc['s-maxage'], 10); // 缓存中的内容属于共享缓存，且 Cache-Control 有 s-maxage，就将 s-maxage 设置视为有效年龄
            }
        }

        // If a response includes a Cache-Control field with the max-age directive, a recipient MUST ignore the Expires field.
        if (this._rescc['max-age']) {
            return parseInt(this._rescc['max-age'], 10); // 最后才用 max-age 的设置
        }

        // 如果 Cache-Control 中有 immutable，那么就认为这是个不变资源，就按系统给的缓存时间
        const defaultMinTtl = this._rescc.immutable ? this._immutableMinTtl : 0;

        const serverDate = this.date(); // 缓存的响应的创建时间
        if (this._resHeaders.expires) {
            const expires = Date.parse(this._resHeaders.expires);
            // A cache recipient MUST interpret invalid date formats, especially the value "0", as representing a time in the past (i.e., "already expired").
            if (Number.isNaN(expires) || expires < serverDate) {
                return 0;
            }

            // 如果缓存的响应中有 expires 头，那么就将到期时间减去响应创建时间这一段时间作为缓存的生命时长
            return Math.max(defaultMinTtl, (expires - serverDate) / 1000);
        }

        if (this._resHeaders['last-modified']) {
            const lastModified = Date.parse(this._resHeaders['last-modified']);
            // 响应创建于响应最新修改时间之后，则将响应的生命时长设为这段时间的 1 / 10
            if (isFinite(lastModified) && serverDate > lastModified) {
                return Math.max(
                    defaultMinTtl,
                    ((serverDate - lastModified) / 1000) * this._cacheHeuristic
                );
            }
        }

        // 啥都没匹配上就返回系统默认的响应生命时长
        return defaultMinTtl;
    }
    // 计算缓存中的响应还能在多久之内有效
    timeToLive() {
        return Math.max(0, this.maxAge() - this.age()) * 1000;
    }

    stale() {
        return this.maxAge() <= this.age(); // 计算出来的缓存生命时长已经过了
    }

    static fromObject(obj) {
        return new this(undefined, undefined, { _fromObject: obj });
    }

    _fromObject(obj) {
        if (this._responseTime) throw Error('Reinitialized');
        if (!obj || obj.v !== 1) throw Error('Invalid serialization');

        this._responseTime = obj.t;
        this._isShared = obj.sh;
        this._cacheHeuristic = obj.ch;
        this._immutableMinTtl =
            obj.imm !== undefined ? obj.imm : 24 * 3600 * 1000;
        this._status = obj.st;
        this._resHeaders = obj.resh;
        this._rescc = obj.rescc;
        this._method = obj.m;
        this._url = obj.u;
        this._host = obj.h;
        this._noAuthorization = obj.a;
        this._reqHeaders = obj.reqh;
        this._reqcc = obj.reqcc;
    }

    toObject() {
        return {
            v: 1,
            t: this._responseTime,
            sh: this._isShared,
            ch: this._cacheHeuristic,
            imm: this._immutableMinTtl,
            st: this._status,
            resh: this._resHeaders,
            rescc: this._rescc,
            m: this._method,
            u: this._url,
            h: this._host,
            a: this._noAuthorization,
            reqh: this._reqHeaders,
            reqcc: this._reqcc,
        };
    }

    /**
     * Headers for sending to the origin server to revalidate stale response.
     * Allows server to return 304 to allow reuse of the previous response.
     *
     * Hop by hop headers are always stripped.
     * Revalidation headers may be added or removed, depending on request.
     */
    revalidationHeaders(incomingReq) {
        this._assertRequestHasHeaders(incomingReq);
        const headers = this._copyWithoutHopByHopHeaders(incomingReq.headers);

        // This implementation does not understand range requests
        delete headers['if-range'];

        if (!this._requestMatches(incomingReq, true) || !this.storable()) {
            // revalidation allowed via HEAD
            // not for the same resource, or wasn't allowed to be cached anyway
            delete headers['if-none-match'];
            delete headers['if-modified-since'];
            return headers;
        }

        /* MUST send that entity-tag in any cache validation request (using If-Match or If-None-Match) if an entity-tag has been provided by the origin server. */
        if (this._resHeaders.etag) {
            headers['if-none-match'] = headers['if-none-match']
                ? `${headers['if-none-match']}, ${this._resHeaders.etag}`
                : this._resHeaders.etag;
        }

        // Clients MAY issue simple (non-subrange) GET requests with either weak validators or strong validators. Clients MUST NOT use weak validators in other forms of request.
        const forbidsWeakValidators =
            headers['accept-ranges'] ||
            headers['if-match'] ||
            headers['if-unmodified-since'] ||
            (this._method && this._method != 'GET');

        /* SHOULD send the Last-Modified value in non-subrange cache validation requests (using If-Modified-Since) if only a Last-Modified value has been provided by the origin server.
        Note: This implementation does not understand partial responses (206) */
        if (forbidsWeakValidators) {
            delete headers['if-modified-since'];

            if (headers['if-none-match']) {
                const etags = headers['if-none-match']
                    .split(/,/)
                    .filter(etag => {
                        return !/^\s*W\//.test(etag);
                    });
                if (!etags.length) {
                    delete headers['if-none-match'];
                } else {
                    headers['if-none-match'] = etags.join(',').trim();
                }
            }
        } else if (
            this._resHeaders['last-modified'] &&
            !headers['if-modified-since']
        ) {
            headers['if-modified-since'] = this._resHeaders['last-modified'];
        }

        return headers;
    }

    /**
     * Creates new CachePolicy with information combined from the previews response,
     * and the new revalidation response.
     *
     * Returns {policy, modified} where modified is a boolean indicating
     * whether the response body has been modified, and old cached body can't be used.
     *
     * @return {Object} {policy: CachePolicy, modified: Boolean}
     */
    revalidatedPolicy(request, response) {
        this._assertRequestHasHeaders(request);
        if (!response || !response.headers) {
            throw Error('Response headers missing');
        }

        // These aren't going to be supported exactly, since one CachePolicy object
        // doesn't know about all the other cached objects.
        let matches = false;
        if (response.status !== undefined && response.status != 304) {
            matches = false;
        } else if (
            response.headers.etag &&
            !/^\s*W\//.test(response.headers.etag)
        ) {
            // "All of the stored responses with the same strong validator are selected.
            // If none of the stored responses contain the same strong validator,
            // then the cache MUST NOT use the new response to update any stored responses."
            matches =
                this._resHeaders.etag &&
                this._resHeaders.etag.replace(/^\s*W\//, '') ===
                    response.headers.etag;
        } else if (this._resHeaders.etag && response.headers.etag) {
            // "If the new response contains a weak validator and that validator corresponds
            // to one of the cache's stored responses,
            // then the most recent of those matching stored responses is selected for update."
            matches =
                this._resHeaders.etag.replace(/^\s*W\//, '') ===
                response.headers.etag.replace(/^\s*W\//, '');
        } else if (this._resHeaders['last-modified']) {
            matches =
                this._resHeaders['last-modified'] ===
                response.headers['last-modified'];
        } else {
            // If the new response does not include any form of validator (such as in the case where
            // a client generates an If-Modified-Since request from a source other than the Last-Modified
            // response header field), and there is only one stored response, and that stored response also
            // lacks a validator, then that stored response is selected for update.
            if (
                !this._resHeaders.etag &&
                !this._resHeaders['last-modified'] &&
                !response.headers.etag &&
                !response.headers['last-modified']
            ) {
                matches = true;
            }
        }

        if (!matches) {
            return {
                policy: new this.constructor(request, response),
                // Client receiving 304 without body, even if it's invalid/mismatched has no option
                // but to reuse a cached body. We don't have a good way to tell clients to do
                // error recovery in such case.
                modified: response.status != 304,
                matches: false,
            };
        }

        // use other header fields provided in the 304 (Not Modified) response to replace all instances
        // of the corresponding header fields in the stored response.
        const headers = {};
        for (const k in this._resHeaders) {
            headers[k] =
                k in response.headers && !excludedFromRevalidationUpdate[k]
                    ? response.headers[k]
                    : this._resHeaders[k];
        }

        const newResponse = Object.assign({}, response, {
            status: this._status,
            method: this._method,
            headers,
        });
        return {
            policy: new this.constructor(request, newResponse, {
                shared: this._isShared,
                cacheHeuristic: this._cacheHeuristic,
                immutableMinTimeToLive: this._immutableMinTtl,
            }),
            modified: false,
            matches: true,
        };
    }
};
