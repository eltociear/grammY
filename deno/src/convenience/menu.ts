import { Composer, Middleware, MiddlewareObj } from '../composer.ts'
import { Context } from '../context.ts'
import { Filter } from '../filter.ts'
import { InlineKeyboardButton } from '../platform.ts'

const textEncoder = new TextEncoder()
function countBytes(str: string): number {
    return textEncoder.encode(str).length
}

type MenuMiddleware<C extends Context> = Middleware<
    Filter<C, 'callback_query:data'> & {
        menu: {
            nav: (to: string) => Promise<void>
            back: () => Promise<void>
        }
    }
>

const _id = Symbol('menu identifier')
const _mw = Symbol('middleware store')
const _parent = Symbol('parent menu')
const _submenus = Symbol('submenu store')
const _autoAnswer = Symbol('auto answer')

export class Menu<C extends Context = Context> implements MiddlewareObj<C> {
    public readonly inline_keyboard: InlineKeyboardButton[][] = [[]]

    private readonly [_id]: string
    private readonly [_mw] = new Map<string, MenuMiddleware<C>[]>()
    private [_parent]: Menu<C> | undefined = undefined
    private readonly [_submenus] = new Map<string, Menu<C>>()
    private readonly [_autoAnswer]: boolean

    constructor(id: string, autoAnswer = true) {
        if (id.includes('/'))
            throw new Error(`You cannot use '/' in a menu identifier ('${id}')`)
        this[_id] = id
        this[_autoAnswer] = autoAnswer
    }

    row() {
        this.inline_keyboard.push([])
        return this
    }

    text(text: string, ...middleware: MenuMiddleware<C>[]) {
        const path = this.nextPath()
        const button = { text, callback_data: path }
        this.inline_keyboard[this.inline_keyboard.length - 1].push(button)
        this[_mw].set(path, middleware)
        return this
    }

    subMenu(
        text: string,
        menu: Menu<C>,
        options: {
            noBackButton?: boolean
            onAction?: MenuMiddleware<C>
        } = {}
    ) {
        // treat undefined as false
        if (options.noBackButton !== true) {
            const existingParent = menu[_parent]
            if (existingParent !== undefined) {
                throw new Error(
                    `Cannot add the menu '${menu[_id]}' to '${this[_id]}' \
because it is already added to '${existingParent[_id]}' \
and doing so would break overwrite where the back \
button returns to! You can call 'subMenu' with \
'noBackButton: true' to specify that a back button \
should not be provided.`
                )
            }
            menu[_parent] = this
        }
        this[_submenus].set(menu[_id], menu)
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.nav(menu[_id])
        )
    }

    back(
        text: string,
        options: {
            onAction?: MenuMiddleware<C>
        } = {}
    ) {
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.back()
        )
    }

    private nextPath() {
        const row = this.inline_keyboard.length - 1
        const col = this.inline_keyboard[row].length
        const path = `${this[_id]}/${row}/${col}`
        if (countBytes(path) > 64)
            throw new Error(
                `Button path '${path}' would exceed payload size of 64 bytes! Please use a shorter identifier than '${this[_id]}'`
            )
        return path
    }

    middleware() {
        const composer = new Composer<C>()
        composer.on('callback_query:data').lazy(ctx => {
            const path = ctx.callbackQuery.data
            if (!this[_mw].has(path)) return []
            const handler = this[_mw].get(path) as Middleware<C>[]
            const mw = [withNavigation(this), ...handler]
            if (!this[_autoAnswer]) return mw
            const c = new Composer<C>()
            c.fork(ctx => ctx.answerCallbackQuery())
            c.use(...mw)
            return c
        })
        composer.use(...this[_submenus].values())
        return composer.middleware()
    }
}

function withNavigation<C extends Context>(menu: Menu<C>): Middleware<C> {
    const mw: MenuMiddleware<C> = async (ctx, next) => {
        if (ctx.menu !== undefined)
            throw new Error(
                `Already executing menu middleware, cannot run handlers of '${menu[_id]}'!`
            )
        // register ctx.menu
        ctx.menu = {
            nav: async (to: string) => {
                if (menu[_id] === to) return
                if (!menu[_submenus].has(to))
                    throw new Error(
                        `Cannot navigate from '${menu[_id]}' to unknown menu '${to}'!`
                    )
                await ctx.editMessageReplyMarkup({
                    reply_markup: menu[_submenus].get(to),
                })
            },
            back: async () => {
                const parent = menu[_parent]
                if (parent === undefined)
                    throw new Error(
                        `Cannot navigate back from menu ${menu[_id]}, no known parent!`
                    )
                await ctx.editMessageReplyMarkup({
                    reply_markup: menu[_parent],
                })
            },
        }
        // call handlers
        await next()
        // unregister ctx.menu
        Object.assign(ctx, { menu: undefined })
    }
    return mw as Middleware<C>
}
