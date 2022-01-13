import { ApiDecoration } from '@polkadot/api/types';
import { bool, Null, Struct, u128 } from '@polkadot/types';
import { StorageKey } from '@polkadot/types';
import { AssetId, BlockHash } from '@polkadot/types/interfaces';
import { BadRequest } from 'http-errors';

import {
	IAccountAssetApproval,
	IAccountAssetsBalances,
	IAssetBalance,
} from '../../types/responses';
import { AbstractService } from '../AbstractService';

/**
 * This is a type that is necessary for any runtime pre 9160. It excludes the
 * `reason` field which 9160 introduces via the following PR.
 * https://github.com/paritytech/substrate/pull/10382/files#diff-9acae09f48474b7f0b96e7a3d66644e0ce5179464cbb0e00671ad09aa3f73a5fR88
 *
 * Both `PalletAssetsAssetBalance`, and `LegacyPalletAssetsAssetBalance` have either,
 * a `sufficient` or `isSufficient` field exposed instead.
 */
interface PalletAssetsAssetBalance extends Struct {
	readonly balance: u128;
	readonly isFrozen: bool;
	readonly sufficient: bool;
	readonly extra: Null;
}

interface LegacyPalletAssetsAssetBalance extends Struct {
	readonly balance: u128;
	readonly isFrozen: bool;
	readonly isSufficient: bool;
}

export class AccountsAssetsService extends AbstractService {
	/**
	 * Fetch all the `AssetBalance`s alongside their `AssetId`'s for a given array of queried `AssetId`'s.
	 * If none are queried the function will get all `AssetId`'s associated with the
	 * given `AccountId`, and send back all the `AssetsBalance`s.
	 *
	 * @param hash `BlockHash` to make call at
	 * @param address `AccountId` associated with the balances
	 * @param assets An array of `assetId`'s to be queried. If the length is zero
	 * all assetId's associated to the account will be queried
	 */
	async fetchAssetBalances(
		hash: BlockHash,
		address: string,
		assets: number[]
	): Promise<IAccountAssetsBalances> {
		const { api } = this;
		const historicApi = await api.at(hash);

		// Check if this runtime has the assets pallet
		this.checkAssetsError(historicApi);

		const { number } = await api.rpc.chain.getHeader(hash);

		let response;
		if (assets.length === 0) {
			/**
			 * This will query all assets and return them in an array
			 */
			const keys = await historicApi.query.assets.asset.keys();
			const assetIds = this.extractAssetIds(keys);

			response = await this.queryAssets(historicApi, assetIds, address);
		} else {
			/**
			 * This will query all assets by the requested AssetIds
			 */
			response = await this.queryAssets(historicApi, assets, address);
		}

		const at = {
			hash,
			height: number.unwrap().toString(10),
		};

		return {
			at,
			assets: response,
		};
	}

	/**
	 * Fetch all `AccountApproval`'s with a given `AssetId` and a `AssetApprovalKey`
	 * which consists of a `delegate` and an `owner`
	 *
	 * @param hash `BlockHash` to make call at
	 * @param address `AccountId` or owner associated with the approvals
	 * @param assetId `AssetId` associated with the `AssetApproval`
	 * @param delegate `delegate`
	 */
	async fetchAssetApproval(
		hash: BlockHash,
		address: string,
		assetId: number,
		delegate: string
	): Promise<IAccountAssetApproval> {
		const { api } = this;
		const historicApi = await api.at(hash);

		// Check if this runtime has the assets pallet
		this.checkAssetsError(historicApi);

		const [{ number }, assetApproval] = await Promise.all([
			api.rpc.chain.getHeader(hash),
			historicApi.query.assets.approvals(assetId, address, delegate),
		]);

		let amount = null,
			deposit = null;
		if (assetApproval.isSome) {
			({ amount, deposit } = assetApproval.unwrap());
		}

		const at = {
			hash,
			height: number.unwrap().toString(10),
		};

		return {
			at,
			amount,
			deposit,
		};
	}

	/**
	 * Takes in an array of `AssetId`s, and an `AccountId` and returns
	 * all balances tied to those `AssetId`s.
	 *
	 * @param api ApiPromise
	 * @param assets An Array of `AssetId`s or numbers representing `assetId`s
	 * @param address An `AccountId` associated with the queried path
	 */
	async queryAssets(
		historicApi: ApiDecoration<'promise'>,
		assets: AssetId[] | number[],
		address: string
	): Promise<IAssetBalance[]> {
		return Promise.all(
			assets.map(async (assetId: AssetId | number) => {
				const assetBalance = await historicApi.query.assets.account(
					assetId,
					address
				);

				/**
				 * The following checks for three different cases:
				 *
				 * 1. Via runtime v9160 the updated storage introduces a `reason` field,
				 * and polkadot-js wraps the newly returned `PalletAssetsAssetAccount` in an `Option`.
				 *
				 * 2. `query.assets.account()` return `PalletAssetsAssetBalance` which exludes `reasons` but has
				 * `sufficient` as a key.
				 *
				 * 3. The older legacy type of `PalletAssetsAssetBalance` has a key of `isSufficient` instead
				 * of `sufficient`.
				 *
				 */
				let balance = null,
					isFrozen = null,
					isSufficient = null;
				if (assetBalance.isSome) {
					let reason = null;

					({ balance, isFrozen, reason } = assetBalance.unwrap());
					isSufficient = reason.isSufficient;
				} else if (
					(assetBalance as unknown as PalletAssetsAssetBalance).sufficient
				) {
					const tempRef = assetBalance as unknown as PalletAssetsAssetBalance;

					({ balance, isFrozen } = tempRef);
					isSufficient = tempRef.sufficient;
				} else if (assetBalance['isSufficient'] as bool) {
					const tempRef =
						assetBalance as unknown as LegacyPalletAssetsAssetBalance;

					({ balance, isFrozen } = tempRef);
					isSufficient = tempRef.isSufficient;
				}

				return {
					assetId,
					balance,
					isFrozen,
					isSufficient,
				};
			})
		);
	}

	/**
	 * @param keys Extract `assetId`s from an array of storage keys
	 */
	extractAssetIds(keys: StorageKey<[AssetId]>[]): AssetId[] {
		return keys.map(({ args: [assetId] }) => assetId);
	}

	/**
	 * Checks if the historicApi has the assets pallet. If not
	 * it will throw a BadRequest error.
	 *
	 * @param historicApi Decorated historic api
	 */
	private checkAssetsError(historicApi: ApiDecoration<'promise'>): void {
		if (!historicApi.query.assets) {
			throw new BadRequest(
				`The runtime does not include the assets pallet at this block.`
			);
		}
	}
}
