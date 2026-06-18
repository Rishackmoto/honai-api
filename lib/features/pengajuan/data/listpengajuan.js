const express = require('express');
const router = express.Router();
const { getPool } = require('../../../core/network/db');
const fs = require('fs/promises');
const path = require('path');


router.delete('/api/pengajuan/:id', async (req, res) => {

    const { id } = req.params;

    try {

        const pool = await getPool();

        // Hapus detail dulu
        await pool.request()
            .input('id', id)
            .query(`
                DELETE FROM t_pengajuan_penjamin
                WHERE id_pengajuan = @id

                DELETE FROM t_pengajuan_pendiri
                WHERE id_pengajuan = @id

                DELETE FROM t_debitur_perorangan
                WHERE id_pengajuan = @id

                DELETE FROM t_debitur_badan_usaha
                WHERE id_pengajuan = @id

                DELETE FROM t_pengajuan_dokumen
                WHERE id_pengajuan = @id
            `);

        // Hapus utama
        await pool.request()
            .input('id', id)
            .query(`
                DELETE FROM t_pengajuan
                WHERE id_pengajuan = @id
            `);


        // HAPUS FOLDER FILE
        const uploadDir =
              path.join(
              process.cwd(),
              'uploads',
              'pengajuan',
              id
          );    

        res.json({
            status: 'success',
            message: 'Pengajuan berhasil dihapus'
        });

    } catch (error) {

        console.log(error);

        res.status(500).json({
            status: 'error',
            message: error.message
        });

    }

});

module.exports = router;