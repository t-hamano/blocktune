/**
 * Internal dependencies
 */
import type { AiChatRequest } from '..';

/**
 * Keeps the text of each request of an answer.
 *
 * The model says what it changes before it calls the edit tool, so when
 * every edit is applied as it is, the answer ends without sending the
 * results back, and one request is saved. Otherwise the results go back,
 * and the text written before them is taken back, since it may not match
 * what happened. The model then says what it did again.
 *
 * @param onEvent Reports the events of the answer.
 * @return `onEvent`, which keeps the text, and `take`, which returns the
 *         text of the request that ended, and starts the next one.
 */
export function trackRequestText( onEvent: AiChatRequest[ 'onEvent' ] ) {
	let text = '';
	return {
		onEvent: ( ( event ) => {
			if ( event.type === 'text' ) {
				text += event.text;
			}
			return onEvent( event );
		} ) as AiChatRequest[ 'onEvent' ],
		take() {
			const taken = text;
			text = '';
			return taken;
		},
	};
}

/**
 * Ends a request with tool calls: tells whether the answer is done, and
 * otherwise takes back the text written before the calls.
 *
 * @param text    The text of the request.
 * @param replied Whether a result must go back to the model.
 * @param onEvent Reports the events of the answer.
 * @return Whether the answer is done.
 */
export function endToolRequest(
	text: string,
	replied: boolean,
	onEvent: AiChatRequest[ 'onEvent' ]
): boolean {
	// Without text, the model has not said what it did yet.
	if ( ! replied && text.trim() ) {
		return true;
	}
	if ( text ) {
		onEvent( { type: 'discard_text', text } );
	}
	return false;
}
