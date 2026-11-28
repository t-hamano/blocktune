/**
 * WordPress dependencies
 */
import { useDispatch, useSelect } from '@wordpress/data';
import { createInterpolateElement, Fragment, useEffect, useState } from '@wordpress/element';
import { __, isRTL, sprintf } from '@wordpress/i18n';
import { chevronLeft, chevronRight } from '@wordpress/icons';
import { store as preferencesStore } from '@wordpress/preferences';
import { IconButton, Link, Notice, SelectControl, Spinner, Stack, Text } from '@wordpress/ui';

/**
 * Internal dependencies
 */
import { listProviderOptions, type ModelChoice, type ProviderOption } from '../platform/select';
import './style.scss';

type Item = { label: string; value: string | null };

type Props = {
	/**
	 * Called when the user is done and goes back to the chat.
	 */
	onClose: () => void;
};

/**
 * Loads the providers that have an API key, with their models.
 *
 * @return The providers, or `null` while they load, and whether they could
 *         not be loaded.
 */
function useProviderOptions() {
	const [ providers, setProviders ] = useState< ProviderOption[] | null >( null );
	const [ hasError, setHasError ] = useState( false );

	useEffect( () => {
		let isCurrent = true;
		listProviderOptions().then(
			( options ) => isCurrent && setProviders( options ),
			() => isCurrent && setHasError( true )
		);
		return () => {
			isCurrent = false;
		};
	}, [] );

	return { providers, hasError };
}

/**
 * Lets the user choose the provider and model that answer, from the
 * providers that have an API key. The choice is saved for the user.
 *
 * @param props         The props.
 * @param props.onClose Called when the user goes back to the chat.
 */
export function ModelSettings( { onClose }: Props ) {
	const { providers, hasError } = useProviderOptions();
	const { set } = useDispatch( preferencesStore );
	// Preferences are kept in the user's meta, so the choice follows the
	// user to other posts and browsers. `null` means automatic.
	const choice = useSelect(
		( select ) => select( preferencesStore ).get( 'blocktune', 'model' ) as ModelChoice | null,
		[]
	);

	const automatic: Item = {
		label: __( 'Automatic', 'blocktune' ),
		value: null,
	};
	const provider = providers?.find( ( option ) => option.id === choice?.provider );
	const providerItems: Item[] = [
		automatic,
		...( providers ?? [] ).map( ( option ) => ( { label: option.name, value: option.id } ) ),
	];
	// A model the user chose stays listed after the provider retired it, so
	// the choice is shown as it was saved.
	const modelIds =
		provider && choice && ! provider.models.includes( choice.model )
			? [ choice.model, ...provider.models ]
			: ( provider?.models ?? [] );
	const modelItems: Item[] = modelIds.map( ( id ) => ( { label: id, value: id } ) );

	/* translators: Used between list items, there is a space after the comma. */
	const separator = __( ', ', 'blocktune' ); // eslint-disable-line @wordpress/i18n-no-flanking-whitespace
	const usageLinks = ( provider ? [ provider ] : ( providers ?? [] ) ).map( ( option, index ) => (
		<Fragment key={ option.id }>
			{ index > 0 && separator }
			<Link href={ option.usageUrl } openInNewTab>
				{ option.name }
			</Link>
		</Fragment>
	) );

	let content;
	if ( hasError ) {
		content = (
			<Notice.Root intent="error">
				<Notice.Description>
					{ __( 'The providers could not be loaded.', 'blocktune' ) }
				</Notice.Description>
			</Notice.Root>
		);
	} else if ( ! providers ) {
		content = <Spinner aria-label={ __( 'Loading…', 'blocktune' ) } />;
	} else if ( providers.length === 0 ) {
		content = (
			<Text variant="body-sm" className="blocktune-settings__note">
				{ __(
					'The model is chosen by the AI Client, because none of Anthropic, OpenAI, and Google is connected in Connectors.',
					'blocktune'
				) }
			</Text>
		);
	} else {
		content = (
			<>
				<SelectControl
					label={ __( 'Provider', 'blocktune' ) }
					description={ __(
						'Only providers connected in Connectors are listed. Automatic uses the first of Anthropic, OpenAI, and Google that is connected.',
						'blocktune'
					) }
					items={ providerItems }
					value={
						providerItems.find( ( item ) => item.value === ( provider?.id ?? null ) ) ?? automatic
					}
					onValueChange={ ( item: Item | null ) => {
						const next = providers.find( ( option ) => option.id === item?.value );
						set(
							'blocktune',
							'model',
							next
								? {
										provider: next.id,
										model: next.models[ 0 ] ?? '',
									}
								: null
						);
					} }
				/>
				{ provider && choice && (
					<SelectControl
						label={ __( 'Model', 'blocktune' ) }
						items={ modelItems }
						value={ modelItems.find( ( item ) => item.value === choice.model ) ?? null }
						onValueChange={ ( item: Item | null ) => {
							if ( item?.value ) {
								set( 'blocktune', 'model', {
									provider: provider.id,
									model: item.value,
								} );
							}
						} }
					/>
				) }
				<Text variant="body-sm" className="blocktune-settings__note">
					{ createInterpolateElement(
						sprintf(
							/* translators: %s: Links to the usage pages of the providers. */
							__(
								"The provider bills for usage. Check the exact usage on the provider's dashboard: %s",
								'blocktune'
							),
							'<links />'
						),
						{ links: <>{ usageLinks }</> }
					) }
				</Text>
			</>
		);
	}

	return (
		<Stack className="blocktune-settings" direction="column">
			<Stack className="blocktune-settings__header" direction="row" align="center" gap="sm">
				<IconButton
					icon={ isRTL() ? chevronRight : chevronLeft }
					label={ __( 'Back', 'blocktune' ) }
					variant="minimal"
					tone="neutral"
					size="small"
					onClick={ onClose }
				/>
				<Text variant="heading-md" render={ <h2 /> }>
					{ __( 'Chat settings', 'blocktune' ) }
				</Text>
			</Stack>
			<Stack className="blocktune-settings__content" direction="column" gap="lg">
				{ content }
			</Stack>
		</Stack>
	);
}
