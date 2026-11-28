/**
 * WordPress dependencies
 */
import { store as blockEditorStore } from '@wordpress/block-editor';
import { useSelect } from '@wordpress/data';
import { memo, useLayoutEffect, useRef } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { arrowUp, blockDefault, typography } from '@wordpress/icons';
import { isKeyboardEvent } from '@wordpress/keycodes';
import { Icon, IconButton, Notice, Spinner, Stack, Text, TextareaControl } from '@wordpress/ui';

/**
 * Internal dependencies
 */
import {
	CONVERSATION_TOKEN_LIMIT,
	getConversationTokens,
	type AssistantChatMessage,
	type Conversation,
} from '../ai/conversation';
import type { AiChat } from '../ai/use-ai-chat';
import { isInDocument } from '../editor/document-root';
import { getTextSelection } from '../editor/text-target';
import type { AiUsage } from '../platform';
import { AnswerMarkdown } from './answer-markdown';
import './style.scss';

function getActivityLabel( activity: NonNullable< AssistantChatMessage[ 'activity' ] > ) {
	switch ( activity ) {
		case 'thinking':
			return __( 'Thinking…', 'blocktune' );
		case 'editing':
			return __( 'Editing the content…', 'blocktune' );
		case 'reading':
			return __( 'Reading the content…', 'blocktune' );
		default:
			return __( 'Waiting for the answer…', 'blocktune' );
	}
}

/**
 * Describes the tokens an answer used, for example "12,345 input tokens
 * (10,000 cached), 678 output tokens".
 *
 * @param usage The tokens the answer used.
 */
export function formatUsage( usage: AiUsage ) {
	const input = sprintf(
		/* translators: %s: Number of tokens. */
		_n( '%s input token', '%s input tokens', usage.inputTokens, 'blocktune' ),
		usage.inputTokens.toLocaleString()
	);
	const cached = usage.cachedInputTokens
		? sprintf(
				/* translators: %s: Number of tokens. */
				__( '(%s cached)', 'blocktune' ),
				usage.cachedInputTokens.toLocaleString()
			)
		: '';
	const output = sprintf(
		/* translators: %s: Number of tokens. */
		_n( '%s output token', '%s output tokens', usage.outputTokens, 'blocktune' ),
		usage.outputTokens.toLocaleString()
	);

	return cached
		? sprintf(
				/* translators: 1: Input tokens. 2: Cached input tokens. 3: Output tokens. Example: "12,345 input tokens (10,000 cached), 678 output tokens". */
				__( '%1$s %2$s, %3$s', 'blocktune' ),
				input,
				cached,
				output
			)
		: sprintf(
				/* translators: 1: Input tokens. 2: Output tokens. Example: "12,345 input tokens, 678 output tokens". */
				__( '%1$s, %2$s', 'blocktune' ),
				input,
				output
			);
}

// Messages are not changed in place, so only the answer that changed renders
// again, and earlier answers keep their parsed Markdown.
const AssistantMessage = memo( function ( { message }: { message: AssistantChatMessage } ) {
	const activity = message.status === 'streaming' ? message.activity : undefined;

	return (
		<Stack className="blocktune-chat__message is-assistant" direction="column" gap="sm">
			{ message.text && <AnswerMarkdown>{ message.text }</AnswerMarkdown> }
			{ message.editStatus === 'applied' && (
				<Text variant="body-sm" className="blocktune-chat__note">
					{ __( 'Edited the content.', 'blocktune' ) }
				</Text>
			) }
			{ message.editStatus === 'dropped' && (
				<Text variant="body-sm" className="blocktune-chat__note">
					{ __(
						'The edit was not applied because the selected blocks no longer exist.',
						'blocktune'
					) }
				</Text>
			) }
			{ activity && (
				<Stack
					className="blocktune-chat__note"
					direction="row"
					align="center"
					gap="sm"
					role="status"
				>
					<Spinner aria-hidden />
					<Text variant="body-sm">{ getActivityLabel( activity ) }</Text>
				</Stack>
			) }
			{ message.status === 'stopped' && (
				<Text variant="body-sm" className="blocktune-chat__note">
					{ __( 'Stopped.', 'blocktune' ) }
				</Text>
			) }
			{ message.status === 'error' && (
				<Notice.Root intent="error">
					<Notice.Description>
						{ message.error || __( 'The answer could not be loaded.', 'blocktune' ) }
					</Notice.Description>
				</Notice.Root>
			) }
			{ message.usage && message.status !== 'streaming' && (
				<Text variant="body-sm" className="blocktune-chat__usage">
					{ formatUsage( message.usage ) }
				</Text>
			) }
		</Stack>
	);
} );

/**
 * Describes what is selected in the editor now, which is sent with the
 * next message: "Text selected" or "3 blocks selected" with an icon, or
 * nothing. It also tells whether the selection is in the document, and not
 * in a block whose content is edited in its own editor.
 *
 * @param documentRoot The block that holds the document, if any.
 */
function useSelectionStatus( documentRoot: string | undefined ) {
	return useSelect(
		( select ) => {
			const editor = select( blockEditorStore );
			const text = getTextSelection( editor );
			if ( text ) {
				return {
					icon: typography,
					label: __( 'Text selected', 'blocktune' ),
					isInDocument: isInDocument( text.clientId, documentRoot, editor ),
				};
			}
			const clientIds = editor.getSelectedBlockClientIds();
			if ( ! clientIds.length ) {
				return null;
			}
			return {
				icon: blockDefault,
				label: sprintf(
					/* translators: %d: Number of selected blocks. */
					_n( '%d block selected', '%d blocks selected', clientIds.length, 'blocktune' ),
					clientIds.length
				),
				isInDocument: clientIds.every( ( clientId ) =>
					isInDocument( clientId, documentRoot, editor )
				),
			};
		},
		[ documentRoot ]
	);
}

/**
 * Keeps the latest message in view while the answer streams in, but only
 * while the messages are scrolled to the bottom, so the chat stays still
 * while the user reads above.
 *
 * @param conversation The conversation shown in the messages.
 * @return The ref and scroll handler for the messages, and a function that
 *         makes the chat follow the next answer.
 */
function useFollowLatest( conversation: Conversation ) {
	const ref = useRef< HTMLDivElement >( null );
	const isAtBottomRef = useRef( true );

	// This runs before the browser paints, so a scroll event never sees new
	// text that the chat has not followed yet.
	useLayoutEffect( () => {
		const element = ref.current;
		if ( element && isAtBottomRef.current ) {
			element.scrollTop = element.scrollHeight;
		}
	}, [ conversation ] );

	const onScroll = ( event: React.UIEvent< HTMLDivElement > ) => {
		const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
		isAtBottomRef.current = scrollHeight - clientHeight - scrollTop <= 1;
	};

	const follow = () => {
		isAtBottomRef.current = true;
	};

	return { ref, onScroll, follow };
}

type Props = {
	chat: AiChat;
	/**
	 * Whether the user can send messages. The assistant edits blocks, so it
	 * is not available in the code editor.
	 */
	isAvailable: boolean;
	/**
	 * The block that holds the document, when it is not the whole editor.
	 */
	documentRoot?: string;
	/**
	 * The message the user is writing. It is kept by the parent, so it
	 * survives while the chat is not shown.
	 */
	draft: string;
	onDraftChange: ( draft: string ) => void;
};

export function Chat( { chat, isAvailable, documentRoot, draft, onDraftChange: setDraft }: Props ) {
	const { conversation, isResponding, sendMessage, stopAnswer, startNewConversation } = chat;
	const { ref: messagesRef, onScroll, follow: followAnswer } = useFollowLatest( conversation );
	const selection = useSelectionStatus( documentRoot );
	// The content of a template part or a synced pattern is edited in its
	// own editor, so a selection inside one cannot be sent.
	const isSelectionOutside = !! selection && ! selection.isInDocument;

	const isLong =
		! isResponding && getConversationTokens( conversation.messages ) > CONVERSATION_TOKEN_LIMIT;

	const canSend = isAvailable && !! draft.trim() && ! isResponding && ! isSelectionOutside;

	const submit = () => {
		if ( canSend ) {
			// The user wants to see the answer to their message.
			followAnswer();
			sendMessage( draft );
			setDraft( '' );
		}
	};

	// Enter sends, and Shift+Enter adds a line.
	const onKeyDown = ( event: React.KeyboardEvent< HTMLTextAreaElement > ) => {
		// Keys that control an IME conversion are left to the IME. Some
		// browsers, such as Safari, report them with key code 229 only.
		if ( event.nativeEvent.isComposing || event.keyCode === 229 ) {
			return;
		}
		// Undo and redo act on the draft, not on the post.
		if (
			isKeyboardEvent.primary( event.nativeEvent, 'z' ) ||
			isKeyboardEvent.primaryShift( event.nativeEvent, 'z' ) ||
			isKeyboardEvent.primary( event.nativeEvent, 'y' )
		) {
			event.stopPropagation();
			return;
		}
		if ( event.key === 'Enter' && ! event.shiftKey ) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<Stack className="blocktune-chat" direction="column">
			<Stack
				className="blocktune-chat__messages"
				direction="column"
				gap="lg"
				ref={ messagesRef }
				onScroll={ onScroll }
			>
				{ ! isAvailable && (
					<Notice.Root intent="info">
						<Notice.Description>
							{ __( 'Switch to the visual editor to use the AI chat.', 'blocktune' ) }
						</Notice.Description>
					</Notice.Root>
				) }
				{ isAvailable && conversation.messages.length === 0 && (
					<Text variant="body-sm" className="blocktune-chat__note">
						{ __(
							'Ask the AI to write or edit. The selected blocks are sent with your message.',
							'blocktune'
						) }
					</Text>
				) }
				{ conversation.messages.map( ( message ) =>
					message.role === 'assistant' ? (
						<AssistantMessage key={ message.id } message={ message } />
					) : (
						<Text key={ message.id } className="blocktune-chat__message is-user" render={ <div /> }>
							{ message.text }
						</Text>
					)
				) }
				{ isLong && (
					<Notice.Root intent="warning">
						<Notice.Description>
							{ __(
								'This conversation has grown long, so each message costs more. Start a new conversation to keep the cost down.',
								'blocktune'
							) }
						</Notice.Description>
						<Notice.Actions>
							<Notice.ActionButton onClick={ startNewConversation }>
								{ __( 'New conversation', 'blocktune' ) }
							</Notice.ActionButton>
						</Notice.Actions>
					</Notice.Root>
				) }
			</Stack>
			<Stack
				render={
					<form
						onSubmit={ ( event ) => {
							event.preventDefault();
							submit();
						} }
					/>
				}
				className="blocktune-chat__composer"
				direction="column"
				gap="sm"
			>
				{ isAvailable && isSelectionOutside && (
					<Notice.Root intent="info">
						<Notice.Description>
							{ __(
								'The selection is in a template part, a synced pattern, or another block whose content is edited on its own. To edit it with AI, open the block in its own editor first.',
								'blocktune'
							) }
						</Notice.Description>
					</Notice.Root>
				) }
				<TextareaControl
					className="blocktune-chat__input"
					label={ __( 'Message', 'blocktune' ) }
					hideLabelFromVision
					placeholder={ __( 'Ask the AI', 'blocktune' ) }
					value={ draft }
					onValueChange={ setDraft }
					onKeyDown={ onKeyDown }
					disabled={ ! isAvailable }
				/>
				<Stack direction="row" align="center" justify="space-between" gap="sm">
					<Stack
						className="blocktune-chat__selection"
						direction="row"
						align="center"
						gap="xs"
						aria-live="polite"
					>
						{ isAvailable && selection && (
							<>
								<Icon icon={ selection.icon } />
								<Text variant="body-sm">{ selection.label }</Text>
							</>
						) }
					</Stack>
					{ isResponding ? (
						<IconButton
							icon={
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
									<path d="M7 7h10v10H7z" fill="currentColor" />
								</svg>
							}
							label={ __( 'Stop', 'blocktune' ) }
							tone="neutral"
							size="compact"
							onClick={ stopAnswer }
						/>
					) : (
						<IconButton
							type="submit"
							icon={ arrowUp }
							label={ __( 'Send', 'blocktune' ) }
							size="compact"
							disabled={ ! canSend }
						/>
					) }
				</Stack>
			</Stack>
		</Stack>
	);
}
