/* eslint-disable */

const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');
const { MAX_UINT256, ZERO_ADDRESS, ZERO_BYTES32 } = constants;

const { fromRpcSig } = require('ethereumjs-util');
const ethSigUtil = require('eth-sig-util');
const Wallet = require('ethereumjs-wallet').default;

const { promisify } = require('util');
const queue = promisify(setImmediate);
const RegisterArtifact = require('../../artifacts/contracts/RequiemVotesRegister.sol/RequiemVotesRegister.json')

const MockRegisteredToken = artifacts.require('MockRegisteredToken');
const VotingRegister = artifacts.require('RequiemVotesRegister');
const TransparentUpgradeableProxy = artifacts.require('TransparentUpgradeableProxy');
const ProxyAdmin = artifacts.require('ProxyAdmin');



const { EIP712Domain, domainSeparator } = require('../helpers/eip712');
const { Contract } = require('ethers');

const Delegation = [
  { name: 'token', type: 'address' },
  { name: 'delegatee', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
];

async function countPendingTransactions() {
  return parseInt(
    await network.provider.send('eth_getBlockTransactionCountByNumber', ['pending'])
  );
}

async function batchInBlock(txs) {
  try {
    // disable auto-mining
    await network.provider.send('evm_setAutomine', [false]);
    // send all transactions
    const promises = txs.map(fn => fn());
    // wait for node to have all pending transactions
    while (txs.length > await countPendingTransactions()) {
      await queue();
    }
    // mine one block
    await network.provider.send('evm_mine');
    // fetch receipts
    const receipts = await Promise.all(promises);
    // Sanity check, all tx should be in the same block
    const minedBlocks = new Set(receipts.map(({ receipt }) => receipt.blockNumber));
    expect(minedBlocks.size).to.equal(1);

    return receipts;
  } finally {
    // enable auto-mining
    await network.provider.send('evm_setAutomine', [true]);
  }
}

contract('Requiem Votes Register Upgradeable: Base', function (accounts) {
  const [holder, recipient, holderDelegatee, recipientDelegatee, other1, other2] = accounts;

  let name;
  const symbol = 'MTKN';
  const version = '1';
  const supply = new BN('10000000000000000000000000');

  beforeEach(async function () {

    // const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    // const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')

    // deploy admin
    const admin = await ProxyAdmin.new({ from: holder })
    // deploy logic
    const register = await VotingRegister.new({ from: holder })

    // deploy proxy
    const proxy = await TransparentUpgradeableProxy.new(register.address, admin.address, Buffer.from(""), { from: holder })

    this.register = await VotingRegister.at(proxy.address)
    name = "RequiemVotesRegister"
    await this.register.initialize(name, { from: holder })
    // await this.register.transferOwnership(holder)
    this.token1 = await MockRegisteredToken.new(name, symbol, this.register.address);
    await this.register.authorize(holder, { from: holder })
    await this.register.registerToken(this.token1.address, { from: holder })
    // name = await this.register.name()
    // We get the chain id from the contract because Ganache (used for coverage) does not return the same chain id
    // from within the EVM as from the JSON RPC interface.
    // See https://github.com/trufflesuite/ganache-core/issues/515
    this.chainId = await this.token1.getChainId();

  });

  it('initial nonce is 0', async function () {
    expect(await this.register.nonces(holder)).to.be.bignumber.equal('0');
  });

  it('register token:unauthorized', async function () {
    await expectRevert(
      this.register.registerToken(this.token1.address, { from: other1 }),
      "VotesRegister: unauthorized"
    );
  });

  it('register token', async function () {

    expect(
      await this.register.isRegistered(this.token1.address),
    ).to.equal(
      true,
    );
  });


  it('domain separator', async function () {
    expect(
      await this.register.DOMAIN_SEPARATOR(),
    ).to.equal(
      await domainSeparator(name, version, this.chainId, this.register.address),
    );
  });

  // it('minting restriction', async function () {
  //   const amount = new BN('2').pow(new BN('224'));
  //   await expectRevert(
  //     this.token.mint(holder, amount),
  //     'ERC20Votes: total supply risks overflowing votes',
  //   );
  // });

  describe('set delegation', function () {
    describe('call', function () {
      it('delegation with balance', async function () {
        await this.token1.mint(holder, supply);
        expect(await this.register.delegates(holder, this.token1.address)).to.be.equal(ZERO_ADDRESS);
        const { receipt } = await this.register.delegate(holder, this.token1.address, { from: holder });
        expectEvent(receipt, 'DelegateChanged', {
          token: this.token1.address,
          delegator: holder,
          fromDelegate: ZERO_ADDRESS,
          toDelegate: holder,
        });
        expectEvent(receipt, 'DelegateVotesChanged', {
          token: this.token1.address,
          delegate: holder,
          previousBalance: '0',
          newBalance: supply,
        });

        expect(await this.register.delegates(holder, this.token1.address)).to.be.equal(holder);

        expect(await this.register.getVotes(holder, this.token1.address)).to.be.bignumber.equal(supply);
        expect(await this.register.getPastVotes(holder, this.token1.address, receipt.blockNumber - 1)).to.be.bignumber.equal('0');
        await time.advanceBlock();
        expect(await this.register.getPastVotes(holder, this.token1.address, receipt.blockNumber)).to.be.bignumber.equal(supply);
      });

      it('delegation without balance', async function () {
        expect(await this.register.delegates(holder, this.token1.address)).to.be.equal(ZERO_ADDRESS);

        const { receipt } = await this.register.delegate(holder, this.token1.address, { from: holder });
        expectEvent(receipt, 'DelegateChanged', {
          token: this.token1.address,
          delegator: holder,
          fromDelegate: ZERO_ADDRESS,
          toDelegate: holder,
        });
        expectEvent.notEmitted(receipt, 'DelegateVotesChanged');

        expect(await this.register.delegates(holder, this.token1.address)).to.be.equal(holder);
      });
    });

    describe('with signature', function () {
      const delegator = Wallet.generate();
      const delegatorAddress = web3.utils.toChecksumAddress(delegator.getAddressString());
      const nonce = 0;

      const buildData = (chainId, verifyingContract, message) => ({
        data: {
          primaryType: 'Delegation',
          types: { EIP712Domain, Delegation },
          domain: { name, version, chainId, verifyingContract },
          message,
        }
      });

      beforeEach(async function () {
        await this.token1.mint(delegatorAddress, supply);
      });

      it('accept signed delegation', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.register.address,
            {
              token: this.token1.address,
              delegatee: delegatorAddress,
              nonce,
              expiry: MAX_UINT256,
            }),
        ));

        expect(await this.register.delegates(delegatorAddress, this.token1.address)).to.be.equal(ZERO_ADDRESS);

        const { receipt } = await this.register.delegateBySig(delegatorAddress, this.token1.address, nonce, MAX_UINT256, v, r, s);

        expectEvent(receipt, 'DelegateChanged', {
          token: this.token1.address,
          delegator: delegatorAddress,
          fromDelegate: ZERO_ADDRESS,
          toDelegate: delegatorAddress,
        });
        expectEvent(receipt, 'DelegateVotesChanged', {
          token: this.token1.address,
          delegate: delegatorAddress,
          previousBalance: '0',
          newBalance: supply,
        });

        expect(await this.register.delegates(delegatorAddress, this.token1.address)).to.be.equal(delegatorAddress);

        expect(await this.register.getVotes(delegatorAddress, this.token1.address)).to.be.bignumber.equal(supply);
        expect(await this.register.getPastVotes(delegatorAddress, this.token1.address, receipt.blockNumber - 1)).to.be.bignumber.equal('0');
        await time.advanceBlock();
        expect(await this.register.getPastVotes(delegatorAddress, this.token1.address, receipt.blockNumber)).to.be.bignumber.equal(supply);
      });

      it('rejects reused signature', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.token1.address, {
            token: this.token1.address,
            delegatee: delegatorAddress,
            nonce,
            expiry: MAX_UINT256,
          }),
        ));

        await this.register.delegateBySig(delegatorAddress, this.token1.address, nonce, MAX_UINT256, v, r, s);

        await expectRevert(
          this.register.delegateBySig(delegatorAddress, this.token1.address, nonce, MAX_UINT256, v, r, s),
          'VotesRegister: invalid nonce',
        );
      });

      it('rejects bad delegatee', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.register.address, {
            token: this.token1.address,
            delegatee: delegatorAddress,
            nonce,
            expiry: MAX_UINT256,
          }),
        ));

        const receipt = await this.register.delegateBySig(holderDelegatee, this.token1.address, nonce, MAX_UINT256, v, r, s);
        const { args } = receipt.logs.find(({ event }) => event == 'DelegateChanged');
        expect(args.delegator).to.not.be.equal(delegatorAddress);
        expect(args.fromDelegate).to.be.equal(ZERO_ADDRESS);
        expect(args.toDelegate).to.be.equal(holderDelegatee);
      });

      it('rejects bad nonce', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.register.address, {
            token: this.token1.address,
            delegatee: delegatorAddress,
            nonce,
            expiry: MAX_UINT256,
          }),
        ));
        await expectRevert(
          this.register.delegateBySig(delegatorAddress, this.token1.address, nonce + 1, MAX_UINT256, v, r, s),
          'VotesRegister: invalid nonce',
        );
      });

      it('rejects expired permit', async function () {
        const expiry = (await time.latest()) - time.duration.weeks(1);
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.register.address, {
            token: this.token1.address,
            delegatee: delegatorAddress,
            nonce,
            expiry,
          }),
        ));

        await expectRevert(
          this.register.delegateBySig(delegatorAddress, this.token1.address, nonce, expiry, v, r, s),
          'VotesRegister: signature expired',
        );
      });
    });
  });

  describe('change delegation', function () {
    beforeEach(async function () {
      await this.token1.mint(holder, supply);
      await this.register.delegate(holder, this.token1.address, { from: holder });
    });

    it('call', async function () {
      expect(await this.register.delegates(holder, this.token1.address)).to.be.equal(holder);

      const { receipt } = await this.register.delegate(holderDelegatee, this.token1.address, { from: holder });
      expectEvent(receipt, 'DelegateChanged', {
        token: this.token1.address,
        delegator: holder,
        fromDelegate: holder,
        toDelegate: holderDelegatee,
      });
      expectEvent(receipt, 'DelegateVotesChanged', {
        token: this.token1.address,
        delegate: holder,
        previousBalance: supply,
        newBalance: '0',
      });
      expectEvent(receipt, 'DelegateVotesChanged', {
        token: this.token1.address,
        delegate: holderDelegatee,
        previousBalance: '0',
        newBalance: supply,
      });

      expect(await this.register.delegates(holder, this.token1.address)).to.be.equal(holderDelegatee);

      expect(await this.register.getVotes(holder, this.token1.address)).to.be.bignumber.equal('0');
      expect(await this.register.getVotes(holderDelegatee, this.token1.address)).to.be.bignumber.equal(supply);
      expect(await this.register.getPastVotes(holder, this.token1.address, receipt.blockNumber - 1)).to.be.bignumber.equal(supply);
      expect(await this.register.getPastVotes(holderDelegatee, this.token1.address, receipt.blockNumber - 1)).to.be.bignumber.equal('0');
      await time.advanceBlock();
      expect(await this.register.getPastVotes(holder, this.token1.address, receipt.blockNumber)).to.be.bignumber.equal('0');
      expect(await this.register.getPastVotes(holderDelegatee, this.token1.address, receipt.blockNumber)).to.be.bignumber.equal(supply);
    });
  });

  describe('transfers', function () {
    beforeEach(async function () {
      await this.token1.mint(holder, supply);
    });

    it('no delegation', async function () {
      const { receipt } = await this.token1.transfer(recipient, 1, { from: holder });
      expectEvent(receipt, 'Transfer', { from: holder, to: recipient, value: '1' });
      expectEvent.notEmitted(receipt, 'DelegateVotesChanged');

      this.holderVotes = '0';
      this.recipientVotes = '0';
    });

    it('sender delegation', async function () {
      await this.register.delegate(holder, this.token1.address, { from: holder });

      const { receipt } = await this.token1.transfer(recipient, 1, { from: holder });
      expectEvent(receipt, 'Transfer', { from: holder, to: recipient, value: '1' });

      // this event cannot be recognized in this framework as it is emitted in a call within the transfer function
      // expectEvent(receipt, 'DelegateVotesChanged', {
      //   token: this.token1.address,
      //   delegate: holder,
      //   previousBalance: supply,
      //   newBalance: supply.subn(1)
      // });

      const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      // expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.holderVotes = supply.subn(1);
      this.recipientVotes = '0';
    });

    it('receiver delegation', async function () {
      await this.register.delegate(recipient, this.token1.address, { from: recipient });

      const { receipt } = await this.token1.transfer(recipient, 1, { from: holder });
      expectEvent(receipt, 'Transfer', { from: holder, to: recipient, value: '1' });
      // expectEvent(receipt, 'DelegateVotesChanged', { delegate: recipient, previousBalance: '0', newBalance: '1' });

      const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      // expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.holderVotes = '0';
      this.recipientVotes = '1';
    });

    it('full delegation', async function () {
      await this.register.delegate(holder, this.token1.address, { from: holder });
      await this.register.delegate(recipient, this.token1.address, { from: recipient });

      const { receipt } = await this.token1.transfer(recipient, 1, { from: holder });
      expectEvent(receipt, 'Transfer', { from: holder, to: recipient, value: '1' });
      // expectEvent(receipt, 'DelegateVotesChanged', { delegate: holder, previousBalance: supply, newBalance: supply.subn(1) });
      // expectEvent(receipt, 'DelegateVotesChanged', { delegate: recipient, previousBalance: '0', newBalance: '1' });

      const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      // expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.holderVotes = supply.subn(1);
      this.recipientVotes = '1';
    });

    afterEach(async function () {
      expect(await this.register.getVotes(holder, this.token1.address)).to.be.bignumber.equal(this.holderVotes);
      expect(await this.register.getVotes(recipient, this.token1.address)).to.be.bignumber.equal(this.recipientVotes);

      // need to advance 2 blocks to see the effect of a transfer on "getPastVotes"
      const blockNumber = await time.latestBlock();
      await time.advanceBlock();
      expect(await this.register.getPastVotes(holder, this.token1.address, blockNumber)).to.be.bignumber.equal(this.holderVotes);
      expect(await this.register.getPastVotes(recipient, this.token1.address, blockNumber)).to.be.bignumber.equal(this.recipientVotes);
    });
  });

  // The following tests are a adaptation of https://github.com/compound-finance/compound-protocol/blob/master/tests/Governance/CompTest.js.
  describe('Compound test suite', function () {
    beforeEach(async function () {
      await this.token1.mint(holder, supply);
    });

    describe('balanceOf', function () {
      it('grants to initial account', async function () {
        expect(await this.token1.balanceOf(holder)).to.be.bignumber.equal('10000000000000000000000000');
      });
    });

    describe('numCheckpoints', function () {
      it('returns the number of checkpoints for a delegate', async function () {
        await this.token1.transfer(recipient, '100', { from: holder }); //give an account a few tokens for readability
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('0');

        const t1 = await this.register.delegate(other1, this.token1.address, { from: recipient });
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('1');

        const t2 = await this.token1.transfer(other2, 10, { from: recipient });
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('2');

        const t3 = await this.token1.transfer(other2, 10, { from: recipient });
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('3');

        const t4 = await this.token1.transfer(recipient, 20, { from: holder });
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('4');

        expect(await this.register.checkpoints(other1, this.token1.address, 0)).to.be.deep.equal([t1.receipt.blockNumber.toString(), '100']);
        expect(await this.register.checkpoints(other1, this.token1.address, 1)).to.be.deep.equal([t2.receipt.blockNumber.toString(), '90']);
        expect(await this.register.checkpoints(other1, this.token1.address, 2)).to.be.deep.equal([t3.receipt.blockNumber.toString(), '80']);
        expect(await this.register.checkpoints(other1, this.token1.address, 3)).to.be.deep.equal([t4.receipt.blockNumber.toString(), '100']);

        await time.advanceBlock();
        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber)).to.be.bignumber.equal('100');
        expect(await this.register.getPastVotes(other1, this.token1.address, t2.receipt.blockNumber)).to.be.bignumber.equal('90');
        expect(await this.register.getPastVotes(other1, this.token1.address, t3.receipt.blockNumber)).to.be.bignumber.equal('80');
        expect(await this.register.getPastVotes(other1, this.token1.address, t4.receipt.blockNumber)).to.be.bignumber.equal('100');
      });

      it('does not add more than one checkpoint in a block', async function () {
        await this.token1.transfer(recipient, '100', { from: holder });
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('0');

        // gas cost here is higher than erc20Votes due to external call to register on transfer
        const [t1, t2, t3] = await batchInBlock([
          () => this.register.delegate(other1, this.token1.address, { from: recipient, gas: 150000 }),
          () => this.token1.transfer(other2, 10, { from: recipient, gas: 150000 }),
          () => this.token1.transfer(other2, 10, { from: recipient, gas: 150000 }),
        ]);
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('1');
        expect(await this.register.checkpoints(other1, this.token1.address, 0)).to.be.deep.equal([t1.receipt.blockNumber.toString(), '80']);
        // expectReve(await this.register.checkpoints(other1, 1)).to.be.deep.equal([ '0', '0' ]); // Reverts due to array overflow check
        // expect(await this.register.checkpoints(other1, 2)).to.be.deep.equal([ '0', '0' ]); // Reverts due to array overflow check

        const t4 = await this.token1.transfer(recipient, 20, { from: holder });
        expect(await this.register.numCheckpoints(other1, this.token1.address)).to.be.bignumber.equal('2');
        expect(await this.register.checkpoints(other1, this.token1.address, 1)).to.be.deep.equal([t4.receipt.blockNumber.toString(), '100']);
      });
    });

    describe('getPastVotes', function () {
      it('reverts if block number >= current block', async function () {
        await expectRevert(
          this.register.getPastVotes(other1, this.token1.address, 5e10),
          'VotesRegister: block not yet mined',
        );
      });

      it('returns 0 if there are no checkpoints', async function () {
        expect(await this.register.getPastVotes(other1, this.token1.address, 0)).to.be.bignumber.equal('0');
      });

      it('returns the latest block if >= last checkpoint block', async function () {
        const t1 = await this.register.delegate(other1, this.token1.address, { from: holder });
        await time.advanceBlock();
        await time.advanceBlock();

        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      });

      it('returns zero if < first checkpoint block', async function () {
        await time.advanceBlock();
        const t1 = await this.register.delegate(other1, this.token1.address, { from: holder });
        await time.advanceBlock();
        await time.advanceBlock();

        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      });

      it('generally returns the voting balance at the appropriate checkpoint', async function () {
        const t1 = await this.register.delegate(other1, this.token1.address, { from: holder });
        await time.advanceBlock();
        await time.advanceBlock();
        const t2 = await this.token1.transfer(other2, 10, { from: holder });
        await time.advanceBlock();
        await time.advanceBlock();
        const t3 = await this.token1.transfer(other2, 10, { from: holder });
        await time.advanceBlock();
        await time.advanceBlock();
        const t4 = await this.token1.transfer(holder, 20, { from: other2 });
        await time.advanceBlock();
        await time.advanceBlock();

        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.register.getPastVotes(other1, this.token1.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.register.getPastVotes(other1, this.token1.address, t2.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999990');
        expect(await this.register.getPastVotes(other1, this.token1.address, t2.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999990');
        expect(await this.register.getPastVotes(other1, this.token1.address, t3.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999980');
        expect(await this.register.getPastVotes(other1, this.token1.address, t3.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999980');
        expect(await this.register.getPastVotes(other1, this.token1.address, t4.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.register.getPastVotes(other1, this.token1.address, t4.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      });
    });
  });

  describe('getPastTotalSupply', function () {
    beforeEach(async function () {
      await this.register.delegate(holder, this.token1.address, { from: holder });
    });

    it('reverts if block number >= current block', async function () {
      await expectRevert(
        this.register.getPastTotalSupply(this.token1.address, 5e10),
        'VotesRegister: block not yet mined',
      );
    });

    it('returns 0 if there are no checkpoints', async function () {
      expect(await this.register.getPastTotalSupply(this.token1.address, 0)).to.be.bignumber.equal('0');
    });

    it('returns the latest block if >= last checkpoint block', async function () {
      t1 = await this.token1.mint(holder, supply);

      await time.advanceBlock();
      await time.advanceBlock();

      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber)).to.be.bignumber.equal(supply);
      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal(supply);
    });

    it('returns zero if < first checkpoint block', async function () {
      await time.advanceBlock();
      const t1 = await this.token1.mint(holder, supply);
      await time.advanceBlock();
      await time.advanceBlock();

      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
    });

    it('generally returns the voting balance at the appropriate checkpoint', async function () {
      const t1 = await this.token1.mint(holder, supply);
      await time.advanceBlock();
      await time.advanceBlock();
      const t2 = await this.token1.burn(holder, 10);
      await time.advanceBlock();
      await time.advanceBlock();
      const t3 = await this.token1.burn(holder, 10);
      await time.advanceBlock();
      await time.advanceBlock();
      const t4 = await this.token1.mint(holder, 20);
      await time.advanceBlock();
      await time.advanceBlock();

      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
      expect(await this.register.getPastTotalSupply(this.token1.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      expect(await this.register.getPastTotalSupply(this.token1.address, t2.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999990');
      expect(await this.register.getPastTotalSupply(this.token1.address, t2.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999990');
      expect(await this.register.getPastTotalSupply(this.token1.address, t3.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999980');
      expect(await this.register.getPastTotalSupply(this.token1.address, t3.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999980');
      expect(await this.register.getPastTotalSupply(this.token1.address, t4.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
      expect(await this.register.getPastTotalSupply(this.token1.address, t4.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
    });
  });
});
